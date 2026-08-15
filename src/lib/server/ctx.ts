import { error } from '@sveltejs/kit';
import { validUid } from './store';

type Env = App.Platform['env'];

export function env(platform: App.Platform | undefined): Env {
	if (!platform?.env) {
		throw error(
			503,
			'Cloudflare bindings are unavailable. Run `pnpm dev` (which proxies them) or deploy.'
		);
	}
	return platform.env;
}

/** Every request carries the opaque user id in a header. */
export function uid(request: Request): string {
	const value = request.headers.get('x-tc-uid');
	if (!validUid(value)) throw error(400, 'missing or malformed x-tc-uid header');
	return value;
}
