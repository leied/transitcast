import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env, uid } from '$lib/server/ctx';
import { getConfig, getSeen } from '$lib/server/store';
import { buildSectionMessages } from '$lib/server/script';
import { chat, parseJsonLoose, LLMError } from '$lib/server/llm';
import type { Item, Segment } from '$lib/types';

type LLMSection = { segments?: { title?: string; text?: string; sources?: number[] }[] };

/**
 * Writes one section of the brief. One section per request keeps each LLM call
 * small enough for Groq's 8K tokens-per-minute free tier and keeps CPU per
 * invocation near zero — the Worker is just relaying a fetch.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const e = env(platform);
	const id = uid(request);
	const { sectionId, items } = (await request.json().catch(() => ({}))) as {
		sectionId?: string;
		items?: Item[];
	};
	if (!sectionId || !Array.isArray(items)) throw error(400, 'sectionId and items required');

	const cfg = await getConfig(e, id);
	const section = cfg.sections.find((s) => s.id === sectionId);
	if (!section) throw error(404, 'unknown section');

	// Drop anything already aired in the last week before spending tokens on it.
	const seen = await getSeen(e, id);
	const fresh: Item[] = [];
	const byHash = new Set<string>();
	let skipped = 0;
	for (const it of items) {
		if (seen.has(it.hash)) {
			skipped++;
			continue;
		}
		if (byHash.has(it.hash)) continue; // same story from two feeds
		byHash.add(it.hash);
		fresh.push(it);
	}

	if (fresh.length === 0) {
		return json({ sectionId, segments: [], considered: items.length, used: 0, skipped });
	}

	// Cap what reaches the model so a chatty feed can't blow the token budget.
	const candidates = fresh.slice(0, 30);

	let raw: string;
	try {
		raw = await chat(e, buildSectionMessages(cfg, section, candidates), {
			json: true,
			maxTokens: Math.min(2000, Math.round(section.minutes * 400) + 400)
		});
	} catch (err) {
		if (err instanceof LLMError) {
			// Surface 429s intact so the client can honour Retry-After and back off
			// rather than dropping the section.
			throw error(err.status === 429 ? 429 : 502, {
				message: err.message,
				...(err.retryAfter ? { retryAfter: err.retryAfter } : {})
			} as App.Error);
		}
		throw err;
	}

	const parsed = parseJsonLoose<LLMSection>(raw);
	const segments: Segment[] = [];
	const usedHashes: string[] = [];

	for (const [i, seg] of (parsed.segments ?? []).entries()) {
		const text = (seg.text ?? '').trim();
		if (!text) continue;
		const sources = (seg.sources ?? [])
			.map((n) => candidates[n])
			.filter(Boolean)
			.map((it) => {
				usedHashes.push(it.hash);
				return { title: it.title, url: it.link };
			});
		segments.push({
			id: `${sectionId}-${i}`,
			sectionId,
			title: (seg.title ?? section.title).trim(),
			text,
			sources
		});
	}

	return json({
		sectionId,
		segments,
		// Everything shown to the model counts as aired, not just what it quoted —
		// otherwise rejected stories come back every single day.
		airedHashes: candidates.map((c) => c.hash),
		usedHashes,
		considered: items.length,
		used: segments.length,
		skipped
	});
};
