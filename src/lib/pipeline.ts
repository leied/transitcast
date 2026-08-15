import type { Brief, Config, FeedResult, Item, Segment } from './types';
import { buildIntro, buildOutro } from './intro';
import { estimateMinutes } from './chunk';

export type Progress =
	| { phase: 'feeds'; done: number; total: number; label: string }
	| { phase: 'writing'; done: number; total: number; label: string }
	| { phase: 'saving' }
	| { phase: 'done' };

export type PipelineOptions = {
	/** '' from the browser; the deployed origin when the cron calls back in. */
	base?: string;
	headers: Record<string, string>;
	onProgress?: (p: Progress) => void;
	signal?: AbortSignal;
	/** Wait between section writes. Groq's free tier is 8K tokens/minute. */
	sectionDelayMs?: number;
};

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson<T>(
	url: string,
	body: unknown,
	opts: PipelineOptions,
	retries = 3
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			method: 'POST',
			signal: opts.signal,
			headers: { 'content-type': 'application/json', ...opts.headers },
			body: JSON.stringify(body)
		});

		if (res.ok) return (await res.json()) as T;

		const detail = (await res.json().catch(() => ({}))) as {
			message?: string;
			retryAfter?: number;
		};

		// 429 from the LLM tier is expected, not exceptional — wait it out.
		if (res.status === 429 && attempt < retries) {
			await sleep((detail.retryAfter ? detail.retryAfter * 1000 : 0) || 4000 * (attempt + 1));
			continue;
		}
		throw new Error(detail.message || `${url} failed with ${res.status}`);
	}
}

/**
 * Runs the whole build: fan out feeds, write each section, assemble.
 *
 * Every step is its own HTTP request on purpose. The Workers free plan allows
 * 10ms of CPU per invocation, so the work has to be spread across many small
 * calls rather than done in one. The same code runs in the browser and in the
 * cron handler — only `base` and `headers` differ.
 */
export async function generateBrief(
	cfg: Config,
	opts: PipelineOptions
): Promise<{ brief: Brief; airedHashes: string[] }> {
	const base = opts.base ?? '';
	const sections = cfg.sections.filter((s) => s.enabled);
	const sectionIds = new Set(sections.map((s) => s.id));

	const feeds = cfg.feeds.filter((f) => f.enabled && f.sections.some((id) => sectionIds.has(id)));

	let fetched = 0;
	const results = await pool(feeds, 6, async (feed) => {
		let result: FeedResult;
		try {
			result = await postJson<FeedResult>(`${base}/api/feed`, { feedId: feed.id }, opts, 1);
		} catch (e) {
			result = {
				feedId: feed.id,
				name: feed.name,
				items: [],
				error: e instanceof Error ? e.message : 'failed'
			};
		}
		fetched++;
		opts.onProgress?.({ phase: 'feeds', done: fetched, total: feeds.length, label: feed.name });
		return result;
	});

	const feedErrors = results
		.filter((r) => r.error)
		.map((r) => ({ feedId: r.feedId, name: r.name, error: r.error! }));

	const bySection = new Map<string, Item[]>();
	for (const section of sections) bySection.set(section.id, []);
	for (const result of results) {
		const feed = feeds.find((f) => f.id === result.feedId);
		if (!feed) continue;
		for (const sectionId of feed.sections) {
			bySection.get(sectionId)?.push(...result.items);
		}
	}
	for (const items of bySection.values()) {
		items.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
	}

	const itemsConsidered = results.reduce((n, r) => n + r.items.length, 0);
	const segments: Segment[] = [];
	const airedHashes: string[] = [];
	let skippedAsSeen = 0;
	let written = 0;

	// Sequential, with a gap between calls: the free LLM tier is rate limited per
	// minute, and firing seven sections at once just guarantees 429s.
	for (const section of sections) {
		const items = bySection.get(section.id) ?? [];
		written++;
		opts.onProgress?.({
			phase: 'writing',
			done: written,
			total: sections.length,
			label: section.title
		});
		if (items.length === 0) continue;

		const out = await postJson<{
			segments: Segment[];
			airedHashes?: string[];
			skipped?: number;
		}>(`${base}/api/script`, { sectionId: section.id, items }, opts);

		segments.push(...out.segments);
		airedHashes.push(...(out.airedHashes ?? []));
		skippedAsSeen += out.skipped ?? 0;

		if (opts.sectionDelayMs && section !== sections[sections.length - 1]) {
			await sleep(opts.sectionDelayMs);
		}
	}

	const now = Date.now();
	const titles = [...new Set(segments.map((s) => s.sectionId))]
		.map((id) => sections.find((s) => s.id === id)?.title)
		.filter((t): t is string => !!t);

	const full: Segment[] = [
		{ id: 'intro', sectionId: 'intro', title: 'Intro', text: buildIntro(cfg, titles, now), sources: [] },
		...segments,
		{ id: 'outro', sectionId: 'outro', title: 'Outro', text: buildOutro(), sources: [] }
	];

	const chars = full.reduce((n, s) => n + s.text.length, 0);

	const brief: Brief = {
		id: `${now.toString(36)}`,
		createdAt: new Date(now).toISOString(),
		date: new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date(now)),
		segments: full,
		stats: {
			itemsConsidered,
			itemsUsed: segments.length,
			itemsSkippedAsSeen: skippedAsSeen,
			chars,
			estimatedMinutes: estimateMinutes(chars),
			feedErrors
		}
	};

	return { brief, airedHashes };
}
