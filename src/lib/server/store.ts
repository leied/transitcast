import type { Brief, Config } from '$lib/types';
import { defaultConfig } from '$lib/defaults';

type Env = App.Platform['env'];

const SEEN_TTL_DAYS = 7;

export const key = {
	config: (uid: string) => `cfg:${uid}`,
	brief: (uid: string) => `brief:${uid}:latest`,
	seen: (uid: string) => `seen:${uid}`
};

/** User ids are opaque random strings minted client-side and kept in localStorage. */
export function validUid(uid: string | null | undefined): uid is string {
	return !!uid && /^[a-z0-9]{8,40}$/i.test(uid);
}

export async function getConfig(env: Env, uid: string): Promise<Config> {
	const stored = await env.TC_KV.get(key.config(uid), 'json');
	if (!stored) return defaultConfig();
	// Merge over defaults so configs written by older versions keep working
	// when new fields are added.
	const base = defaultConfig();
	const cfg = stored as Partial<Config>;
	return {
		...base,
		...cfg,
		tts: { ...base.tts, ...cfg.tts },
		schedule: { ...base.schedule, ...cfg.schedule },
		feeds: cfg.feeds ?? base.feeds,
		sections: cfg.sections ?? base.sections
	};
}

export type ConfigMeta = { e: boolean; h: number; a: number };

/** Days since the Unix epoch, UTC. Used as a coarse "last active" stamp. */
function today(): number {
	return Math.floor(Date.now() / 86400_000);
}

export async function putConfig(env: Env, uid: string, cfg: Config): Promise<void> {
	// The schedule is mirrored into KV key metadata so the cron can find due
	// users from a single `list` call instead of reading every config. `a` is
	// the last-active day, which the same list call uses to find abandoned
	// accounts to delete — see cron/worker.js.
	const metadata: ConfigMeta = { e: cfg.schedule.enabled, h: cfg.schedule.hourUTC, a: today() };
	await env.TC_KV.put(key.config(uid), JSON.stringify(cfg), { metadata });
}

/**
 * Stamps today's date as this uid's last-active day, at most once/day so an
 * open app doesn't spend the KV write quota. Only real app opens should count
 * (GET /api/config, fired on every page load) — not the scheduled cron build,
 * which would otherwise keep a config "active" forever even if no one is
 * looking at it anymore.
 */
export async function touchActivity(env: Env, uid: string): Promise<void> {
	const { value, metadata } = await env.TC_KV.getWithMetadata<ConfigMeta>(key.config(uid), 'text');
	if (value === null) return;
	const meta = metadata ?? ({} as Partial<ConfigMeta>);
	const day = today();
	if (meta.a === day) return;
	await env.TC_KV.put(key.config(uid), value, {
		metadata: { e: meta.e ?? false, h: meta.h ?? 0, a: day } satisfies ConfigMeta
	});
}

export async function getBrief(env: Env, uid: string): Promise<Brief | null> {
	return (await env.TC_KV.get(key.brief(uid), 'json')) as Brief | null;
}

export async function putBrief(env: Env, uid: string, brief: Brief): Promise<void> {
	await env.TC_KV.put(key.brief(uid), JSON.stringify(brief));
}

type SeenEntry = { h: string; t: number };

/**
 * Cross-day dedupe. The 24h publish window alone doesn't stop repeats, because
 * feeds re-date items and aggregators re-post the same story — this is the
 * other half of the fix for "half the things are the same as yesterday's".
 */
export async function getSeen(env: Env, uid: string): Promise<Set<string>> {
	const raw = ((await env.TC_KV.get(key.seen(uid), 'json')) as SeenEntry[] | null) ?? [];
	const cutoff = Date.now() - SEEN_TTL_DAYS * 86400_000;
	return new Set(raw.filter((e) => e.t >= cutoff).map((e) => e.h));
}

export async function addSeen(env: Env, uid: string, hashes: string[]): Promise<void> {
	const raw = ((await env.TC_KV.get(key.seen(uid), 'json')) as SeenEntry[] | null) ?? [];
	const cutoff = Date.now() - SEEN_TTL_DAYS * 86400_000;
	const now = Date.now();
	const merged = new Map<string, number>();
	for (const e of raw) if (e.t >= cutoff) merged.set(e.h, e.t);
	for (const h of hashes) merged.set(h, now);
	const out: SeenEntry[] = [...merged].map(([h, t]) => ({ h, t }));
	await env.TC_KV.put(key.seen(uid), JSON.stringify(out));
}
