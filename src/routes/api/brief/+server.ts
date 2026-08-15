import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env, uid } from '$lib/server/ctx';
import { addSeen, getBrief, putBrief } from '$lib/server/store';
import type { Brief } from '$lib/types';

export const GET: RequestHandler = async ({ request, platform }) => {
	const brief = await getBrief(env(platform), uid(request));
	if (!brief) return json(null);
	return json(brief);
};

export const POST: RequestHandler = async ({ request, platform }) => {
	const e = env(platform);
	const id = uid(request);
	const { brief, airedHashes } = (await request.json().catch(() => ({}))) as {
		brief?: Brief;
		airedHashes?: string[];
	};
	if (!brief?.segments) throw error(400, 'brief required');

	await putBrief(e, id, brief);
	if (airedHashes?.length) await addSeen(e, id, airedHashes);
	return json({ ok: true });
};
