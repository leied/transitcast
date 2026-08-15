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

/**
 * One chunk of speech per request. MeloTTS costs 18.63 neurons per audio
 * minute against a 10,000/day free allowance, which is roughly nine hours of
 * speech a day across the whole account. Overage errors rather than bills.
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
	try {
		result = await e.AI.run(MODEL, { prompt, lang: lang || 'en' });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Workers AI call failed';
		// The daily neuron allowance running out looks like a generic failure;
		// name it so the UI can say something true instead of "try again".
		const outOfBudget = /neuron|quota|limit|exceed/i.test(message);
		throw error(outOfBudget ? 429 : 502, {
			message: outOfBudget
				? "Workers AI daily free allowance is used up (10,000 neurons ≈ 9 hours of speech). It resets at 00:00 UTC."
				: message
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
