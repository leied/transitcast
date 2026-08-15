/**
 * Scheduler.
 *
 * This is a second, tiny Worker rather than part of the SvelteKit app because
 * adapter-cloudflare writes its build output over whatever `main` points at, so
 * the app's Worker can't carry a hand-written `scheduled` export. Splitting it
 * out is also cheaper to reason about: this thing only reads KV and makes one
 * HTTP call per due user.
 *
 * It shares the app's KV namespace, so it sees the same configs.
 */
export default {
	/**
	 * @param {import('@cloudflare/workers-types').ScheduledController} event
	 * @param {{ TC_KV: import('@cloudflare/workers-types').KVNamespace, APP_ORIGIN: string, CRON_SECRET: string }} env
	 * @param {import('@cloudflare/workers-types').ExecutionContext} ctx
	 */
	async scheduled(event, env, ctx) {
		ctx.waitUntil(run(event, env));
	},

	/** Manual trigger for testing: GET /?hour=13 with the cron secret. */
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.searchParams.get('secret') !== env.CRON_SECRET) {
			return new Response('nope', { status: 401 });
		}
		const hour = Number(url.searchParams.get('hour') ?? new Date().getUTCHours());
		const summary = await run({ scheduledTime: Date.now() }, env, hour);
		return Response.json(summary);
	}
};

/**
 * @param {{ scheduledTime: number }} event
 * @param {{ TC_KV: any, APP_ORIGIN: string, CRON_SECRET: string }} env
 * @param {number} [forceHour]
 */
async function run(event, env, forceHour) {
	const hour = forceHour ?? new Date(event.scheduledTime).getUTCHours();
	const origin = (env.APP_ORIGIN || '').replace(/\/$/, '');
	if (!origin) {
		console.error('APP_ORIGIN is unset; nothing to call');
		return { error: 'APP_ORIGIN unset' };
	}

	/** @type {string[]} */
	const due = [];
	/** @type {string | undefined} */
	let cursor;

	// The schedule is mirrored into each config key's metadata, so finding due
	// users costs one list call instead of one read per user.
	for (;;) {
		const page = await env.TC_KV.list({ prefix: 'cfg:', cursor, limit: 1000 });
		for (const entry of page.keys) {
			const meta = entry.metadata;
			if (meta?.e && meta.h === hour) due.push(entry.name.slice('cfg:'.length));
		}
		if (page.list_complete) break;
		cursor = page.cursor;
	}

	if (due.length === 0) return { hour, due: 0, built: 0 };

	// Free plan allows 50 subrequests per invocation, one per user here.
	const batch = due.slice(0, 45);
	if (due.length > batch.length) {
		console.warn(`${due.length} due at ${hour}:00 UTC; building ${batch.length} this run`);
	}

	const results = await Promise.allSettled(
		batch.map((uid) =>
			fetch(`${origin}/api/cron`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-tc-cron': env.CRON_SECRET },
				body: JSON.stringify({ uid })
			}).then(async (res) => {
				if (!res.ok) throw new Error(`${uid}: HTTP ${res.status} ${await res.text()}`);
				return res.json();
			})
		)
	);

	const failed = results.filter((r) => r.status === 'rejected');
	for (const f of failed) console.error(f.reason);
	console.log(`cron ${hour}:00 UTC — ${results.length - failed.length}/${results.length} built`);

	return { hour, due: due.length, built: results.length - failed.length, failed: failed.length };
}
