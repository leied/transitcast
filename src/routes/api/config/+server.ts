import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env, uid } from '$lib/server/ctx';
import { getConfig, putConfig } from '$lib/server/store';
import type { Config } from '$lib/types';

export const GET: RequestHandler = async ({ request, platform }) => {
	return json(await getConfig(env(platform), uid(request)));
};

export const PUT: RequestHandler = async ({ request, platform }) => {
	const e = env(platform);
	const id = uid(request);
	const body = (await request.json().catch(() => null)) as Config | null;

	if (!body || !Array.isArray(body.feeds) || !Array.isArray(body.sections)) {
		throw error(400, 'config must include feeds and sections arrays');
	}
	// Clamp the things that would otherwise let a bad client burn the whole
	// Workers AI daily allowance or hammer the LLM tier in one go.
	body.windowHours = Math.min(Math.max(Math.round(body.windowHours) || 24, 1), 168);
	for (const s of body.sections) s.minutes = Math.min(Math.max(s.minutes || 1, 0.5), 15);
	if (body.feeds.length > 60) throw error(400, 'at most 60 feeds');

	await putConfig(e, id, body);
	return json({ ok: true });
};
