import type { Handle } from '@sveltejs/kit';

/**
 * Opt into cross-origin isolation so SharedArrayBuffer exists, which is what
 * lets onnxruntime-web run WASM inference multi-threaded. Without it Kokoro
 * synthesises on one core — measured at 28.8s for nine seconds of audio on a
 * 22-core machine.
 *
 * `credentialless` rather than `require-corp`: Hugging Face serves the model
 * files without a Cross-Origin-Resource-Policy header, so require-corp would
 * block the download outright. credentialless drops credentials instead of
 * demanding CORP, which suits anonymous CDN fetches exactly.
 *
 * This only covers HTML. The Kokoro worker's own script must carry the same
 * header or an isolated page refuses to start it — that lives in /_headers,
 * because static assets are served without ever reaching this hook.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);

	if (response.headers.get('content-type')?.startsWith('text/html')) {
		response.headers.set('cross-origin-opener-policy', 'same-origin');
		response.headers.set('cross-origin-embedder-policy', 'credentialless');
	}

	return response;
};
