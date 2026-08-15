import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env, uid } from '$lib/server/ctx';
import { getConfig } from '$lib/server/store';
import { fetchFeed } from '$lib/server/rss';

/**
 * Fetches exactly one feed. Deliberately one per request: the Workers free plan
 * gives 10ms of CPU per invocation, and parsing a dozen feeds in a single call
 * blows straight through that. The client fans these out instead.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const e = env(platform);
	const id = uid(request);
	const { feedId, url } = (await request.json().catch(() => ({}))) as {
		feedId?: string;
		url?: string;
	};
	if (!feedId) throw error(400, 'feedId required');

	const cfg = await getConfig(e, id);
	const feed = cfg.feeds.find((f) => f.id === feedId);

	// `url` lets the settings page test a feed before it has been saved.
	const target = feed ?? (url ? { id: feedId, name: feedId, url, sections: [], enabled: true } : null);
	if (!target) throw error(404, 'unknown feed');

	const result = await fetchFeed(target, { windowHours: cfg.windowHours, limit: 25 });
	return json(result);
};
