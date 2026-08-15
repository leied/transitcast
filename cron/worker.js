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

	// Accounts with no app open in this many days get their data deleted. `a`
	// (last-active day) is stamped by touchActivity() on every GET /api/config,
	// i.e. every app open — not by the scheduled build below, so an abandoned
	// account with auto-build still enabled doesn't stay "active" forever.
	const inactiveDays = Number(env.INACTIVE_DAYS) || 90;
	const todayNum = Math.floor(Date.now() / 86400_000);

	/** @type {string[]} */
	const due = [];
	/** @type {string[]} */
	const stale = [];
	/** @type {string | undefined} */
	let cursor;

	// The schedule is mirrored into each config key's metadata, so finding due
	// users (and stale ones to delete) costs one list call instead of one read
	// per user.
	for (;;) {
		const page = await env.TC_KV.list({ prefix: 'cfg:', cursor, limit: 1000 });
		for (const entry of page.keys) {
			const meta = entry.metadata;
			if (meta?.e && meta.h === hour) due.push(entry.name.slice('cfg:'.length));
			// Configs saved before this feature shipped have no `a` yet — leave
			// them alone until the next app open stamps one, rather than treating
			// "unknown" as "abandoned".
			if (typeof meta?.a === 'number' && todayNum - meta.a > inactiveDays) {
				stale.push(entry.name.slice('cfg:'.length));
			}
		}
		if (page.list_complete) break;
		cursor = page.cursor;
	}

	// Capped and spread across runs like the due-user batch below, so a big
	// backlog of stale accounts can't blow the free plan's 50-subrequest cap
	// (3 KV deletes each) in one invocation.
	const staleBatch = stale.slice(0, 5);
	if (staleBatch.length) {
		await Promise.allSettled(
			staleBatch.flatMap((uid) => [
				env.TC_KV.delete(`cfg:${uid}`),
				env.TC_KV.delete(`brief:${uid}:latest`),
				env.TC_KV.delete(`seen:${uid}`)
			])
		);
		console.log(
			`deleted ${staleBatch.length} account(s) inactive >${inactiveDays}d: ${staleBatch.join(', ')}`
		);
	}
	if (stale.length > staleBatch.length) {
		console.warn(`${stale.length - staleBatch.length} more stale account(s) queued for next run`);
	}

	if (due.length === 0) return { hour, due: 0, built: 0, deleted: staleBatch.length };

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

	return {
		hour,
		due: due.length,
		built: results.length - failed.length,
		failed: failed.length,
		deleted: staleBatch.length
	};
}
