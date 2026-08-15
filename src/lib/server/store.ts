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

export type ConfigMeta = { e: boolean; h: number };

export async function putConfig(env: Env, uid: string, cfg: Config): Promise<void> {
	// The schedule is mirrored into KV key metadata so the cron can find due
	// users from a single `list` call instead of reading every config.
	const metadata: ConfigMeta = { e: cfg.schedule.enabled, h: cfg.schedule.hourUTC };
	await env.TC_KV.put(key.config(uid), JSON.stringify(cfg), { metadata });
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
