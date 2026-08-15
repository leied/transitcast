import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$lib/server/ctx';
import { addSeen, getConfig, putBrief, validUid } from '$lib/server/store';
import { generateBrief } from '$lib/pipeline';

/**
 * Builds one user's brief on the schedule. Called by the Worker's `scheduled`
 * handler, one HTTP request per due user, so each user's build gets its own
 * CPU and subrequest budget instead of sharing the cron invocation's.
 *
 * Only the script is produced here. Audio is rendered on the device when the
 * app opens, which is what lets the whole thing run without object storage.
 */
export const POST: RequestHandler = async ({ request, platform, url }) => {
	const e = env(platform);
	if (!e.CRON_SECRET || request.headers.get('x-tc-cron') !== e.CRON_SECRET) {
		throw error(401, 'bad cron secret');
	}

	const { uid } = (await request.json().catch(() => ({}))) as { uid?: string };
	if (!validUid(uid)) throw error(400, 'valid uid required');

	const cfg = await getConfig(e, uid);
	const base = e.PUBLIC_ORIGIN?.replace(/\/$/, '') || url.origin;

	const { brief, airedHashes } = await generateBrief(cfg, {
		base,
		headers: { 'x-tc-uid': uid },
		// The cron has wall-clock room the browser doesn't, so pace the section
		// writes to stay under the LLM tier's per-minute cap instead of retrying.
		sectionDelayMs: 3000
	});

	await putBrief(e, uid, brief);
	if (airedHashes.length) await addSeen(e, uid, airedHashes);

	return json({
		ok: true,
		date: brief.date,
		segments: brief.segments.length,
		minutes: brief.stats.estimatedMinutes,
		feedErrors: brief.stats.feedErrors.length
	});
};
