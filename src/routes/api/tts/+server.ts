import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$lib/server/ctx';
import { speakOpenRouter, speakGemini } from '$lib/server/cloud-tts';
import { CHUNK_CHARS } from '$lib/engines';

const MELOTTS = '@cf/myshell-ai/melotts';
const AURA = '@cf/deepgram/aura-1';

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
 * One chunk of speech per request, for whichever server-side engine is chosen:
 *
 *  - melotts / aura: Workers AI. MeloTTS costs 18.63 neurons per audio minute
 *    against a 10,000/day free allowance; Aura 1,363.64 per 1,000 characters
 *    (about one brief a day). Overage errors rather than bills.
 *  - openrouter: OpenRouter's OpenAI-compatible speech endpoint; free model
 *    variants are capped at 50 requests/day. Needs OPENROUTER_API_KEY.
 *  - gemini: Google AI Studio's TTS models, 15 requests/day free. Needs
 *    GEMINI_API_KEY. Returns raw 16-bit PCM, not MP3 — see cloud-tts.ts.
 *
 * Error 3043 ("Internal server error") comes back from MeloTTS often enough
 * to be a design consideration rather than an edge case — Cloudflare has had
 * open reports against MeloTTS since July and an incident on 13 Aug 2026. It's
 * usually transient, so retry here and let the client skip past what survives.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const e = env(platform);
	const { text, lang, engine, speaker, model, voice } = (await request
		.json()
		.catch(() => ({}))) as {
		text?: string;
		lang?: string;
		engine?: string;
		speaker?: string;
		model?: string;
		voice?: string;
	};

	const prompt = (text ?? '').trim();
	if (!prompt) throw error(400, 'text required');

	// The chunkers on the client keep under these; anything bigger is a bug, and
	// for the per-request-metered engines an oversized request is a wasted one.
	const maxChars =
		engine === 'gemini'
			? CHUNK_CHARS.gemini + 500
			: engine === 'openrouter'
				? CHUNK_CHARS.openrouter + 500
				: 1500;
	if (prompt.length > maxChars) throw error(400, 'text too long; chunk it client-side');

	if (engine === 'openrouter') {
		if (!model || !voice) throw error(400, 'model and voice required for the OpenRouter engine');
		const speech = await speakOpenRouter(e, { text: prompt, model, voice });
		return new Response(speech.body as BodyInit, {
			headers: { 'content-type': speech.contentType, 'cache-control': 'no-store' }
		});
	}

	if (engine === 'gemini') {
		if (!voice) throw error(400, 'voice required for the Gemini engine');
		const speech = await speakGemini(e, { text: prompt, voice });
		return new Response(speech.body as BodyInit, {
			headers: { 'content-type': speech.contentType, 'cache-control': 'no-store' }
		});
	}

	// Aura takes `text`/`speaker` and returns MP3; MeloTTS takes `prompt`/`lang`.
	const useAura = engine === 'aura';
	const aiModel = useAura ? AURA : MELOTTS;
	const input = useAura
		? { text: prompt, speaker: speaker || 'asteria' }
		: { prompt, lang: lang || 'en' };

	let result: unknown;
	let lastError = '';

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			result = await e.AI.run(aiModel, input as never);
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
						'Workers AI daily free allowance is used up (10,000 neurons ≈ 9 hours of speech). It resets at 00:00 UTC. Switch the engine in Settings to keep going — Kokoro renders on your device for free, and OpenRouter or Gemini are free cloud engines with their own daily caps.',
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
		console.error(`${aiModel} failed: ${lastError}`);
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
