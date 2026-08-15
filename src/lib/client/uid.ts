import { browser } from '$app/environment';

const KEY = 'transitcast:uid';

/**
 * Identity is a random opaque string in localStorage — no accounts, no
 * passwords. It doubles as a share link: paste ?uid=… and another device picks
 * up the same feeds and briefs. Real auth can be layered on later without
 * moving any of the stored data, since everything is already keyed by this id.
 */
export function getUid(): string {
	if (!browser) return '';

	const fromUrl = new URLSearchParams(location.search).get('uid');
	if (fromUrl && /^[a-z0-9]{8,40}$/i.test(fromUrl)) {
		localStorage.setItem(KEY, fromUrl);
		// Drop it from the address bar so it isn't left sitting in history.
		const url = new URL(location.href);
		url.searchParams.delete('uid');
		history.replaceState(null, '', url);
		return fromUrl;
	}

	let uid = localStorage.getItem(KEY);
	if (!uid) {
		uid = Array.from(crypto.getRandomValues(new Uint8Array(12)))
			.map((b) => b.toString(36).padStart(2, '0'))
			.join('')
			.slice(0, 20);
		localStorage.setItem(KEY, uid);
	}
	return uid;
}

export function authHeaders(): Record<string, string> {
	return { 'x-tc-uid': getUid() };
}
