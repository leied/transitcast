import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$lib/server/ctx';

const MODEL = '@cf/myshell-ai/melotts';

/** Workers AI hands MeloTTS back as either raw bytes or base64 in a JSON wrapper. */
function toBytes(result: unknown): Uint8Array | ReadableStream | null {
	if (!result) return null;
	if (result instanceof ReadableStream) return result;
	if (result instanceof ArrayBuffer) return new Uint8Array(result);
	if (ArrayBuffer.isView(result)) return new Uint8Array((result as ArrayBufferView).buffer);
	if (typeof result === 'object' && 'audio' in result) {
		const audio = (result as { audio: unknown }).audio;
		if (typeof audio === 'string') {
			const bin = atob(audio);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		}
		if (audio instanceof ReadableStream) return audio;
	}
	return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One chunk of speech per request. MeloTTS costs 18.63 neurons per audio
 * minute against a 10,000/day free allowance, which is roughly nine hours of
 * speech a day across the whole account. Overage errors rather than bills.
 *
 * Error 3043 ("Internal server error") comes back from this model often enough
 * to be a design consideration rather than an edge case — Cloudflare has had
 * open reports against MeloTTS since July and an incident on 13 Aug 2026. It's
 * usually transient, so retry here and let the client skip past what survives.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const e = env(platform);
	const { text, lang } = (await request.json().catch(() => ({}))) as {
		text?: string;
		lang?: string;
	};

	const prompt = (text ?? '').trim();
	if (!prompt) throw error(400, 'text required');
	if (prompt.length > 1500) throw error(400, 'text too long; chunk it client-side');

	let result: unknown;
	let lastError = '';

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			result = await e.AI.run(MODEL, { prompt, lang: lang || 'en' });
			lastError = '';
			break;
		} catch (err) {
			lastError = err instanceof Error ? err.message : 'Workers AI call failed';

			// Only code 3036 actually means the free allocation is gone. Matching on
			// words like "limit" or "exceed" reported a used-up allowance while the
			// dashboard read 0/10k neurons — capacity errors say "exceeded" too.
			if (/\b3036\b/.test(lastError)) {
				throw error(429, {
					message:
						'Workers AI daily free allowance is used up (10,000 neurons ≈ 9 hours of speech). It resets at 00:00 UTC. Switch the engine to Kokoro in Settings to keep going — it renders on your device for free.',
					upstream: lastError
				} as App.Error);
			}

			// 3040 is "out of capacity", 3043 is the generic upstream failure.
			// Both are worth another go after a moment.
			if (attempt < 2 && /3040|3043|capacity|internal server|timeout|3007/i.test(lastError)) {
				await sleep(400 * (attempt + 1));
				continue;
			}
			break;
		}
	}

	if (lastError) {
		// Always carry the raw upstream text through. Guessing at what a Workers AI
		// error meant is how the allowance message ended up lying.
		console.error(`melotts failed: ${lastError}`);
		throw error(502, {
			message: `Workers AI could not speak this chunk after three tries: ${lastError.slice(0, 160)}`,
			upstream: lastError
		} as App.Error);
	}

	const body = toBytes(result);
	if (!body) throw error(502, 'Workers AI returned audio in an unrecognised shape');

	return new Response(body as BodyInit, {
		headers: {
			'content-type': 'audio/mpeg',
			'cache-control': 'no-store'
		}
	});
};
