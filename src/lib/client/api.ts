import type { Brief, Config, FeedResult } from '$lib/types';
import { authHeaders } from './uid';

async function req<T>(url: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(url, {
		...init,
		headers: { 'content-type': 'application/json', ...authHeaders(), ...init.headers }
	});
	if (!res.ok) {
		const detail = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(detail.message || `${init.method ?? 'GET'} ${url} → ${res.status}`);
	}
	return (await res.json()) as T;
}

export const api = {
	getConfig: () => req<Config>('/api/config'),
	putConfig: (cfg: Config) =>
		req<{ ok: true }>('/api/config', { method: 'PUT', body: JSON.stringify(cfg) }),
	getBrief: () => req<Brief | null>('/api/brief'),
	saveBrief: (brief: Brief, airedHashes: string[]) =>
		req<{ ok: true }>('/api/brief', {
			method: 'POST',
			body: JSON.stringify({ brief, airedHashes })
		}),
	testFeed: (feedId: string, url: string) =>
		req<FeedResult>('/api/feed', { method: 'POST', body: JSON.stringify({ feedId, url }) })
};
