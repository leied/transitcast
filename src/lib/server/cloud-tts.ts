import { error } from '@sveltejs/kit';

/**
 * The two key-based cloud engines. Both are "free" in the sense that matters
 * to this project — no card, no bill — but each is metered in requests per
 * day, so every helper here is careful to (a) never waste a request and (b)
 * report the exact upstream text when one is refused, because guessing at
 * quota errors is how we ended up lying about the Workers AI allowance.
 */

type Env = App.Platform['env'];

export type Speech = { body: Uint8Array; contentType: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds from a Retry-After header or a Google "retry in 23.4s" hint, else undefined. */
function retryAfterSeconds(res: Response, bodyText: string): number | undefined {
	const header = Number(res.headers.get('retry-after'));
	if (header > 0) return header;
	const hint = bodyText.match(/retry(?:Delay|\s+in)\D{0,4}([\d.]+)\s*s/i);
	if (hint) return Math.ceil(Number(hint[1]));
	return undefined;
}

/**
 * Per-minute limits are worth waiting out inside the request — the client
 * would only retry anyway, and a Worker waiting on a timer costs nothing.
 * Per-day limits are not: surface those immediately with the reset in the
 * message so the user isn't left grinding through 429s.
 */
function looksDaily(text: string): boolean {
	return /per[-_ ]?day|daily|PerDay|requests_per_day|free-models-per-day/i.test(text);
}

const MAX_WAIT_S = 65;

/* ───────────────────────────── OpenRouter ───────────────────────────── */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/audio/speech';

export async function speakOpenRouter(
	env: Env,
	{ text, model, voice }: { text: string; model: string; voice: string }
): Promise<Speech> {
	const key = env.OPENROUTER_API_KEY;
	if (!key) {
		throw error(503, {
			message:
				'The OpenRouter engine needs an API key on the server. Make one at openrouter.ai/keys (free, no card) and run: pnpm wrangler secret put OPENROUTER_API_KEY (no redeploy needed; secrets apply to the running Worker).'
		} as App.Error);
	}

	let waited = 0;
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch(OPENROUTER_URL, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${key}`,
				'content-type': 'application/json',
				// OpenRouter asks for these so the app shows up in their rankings; harmless.
				'HTTP-Referer': env.PUBLIC_ORIGIN || 'https://transitcast.workers.dev',
				'X-Title': 'TransitCast'
			},
			body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' })
		});

		if (res.ok) {
			const body = new Uint8Array(await res.arrayBuffer());
			if (body.byteLength === 0) throw error(502, 'OpenRouter returned an empty audio body');
			return { body, contentType: res.headers.get('content-type') || 'audio/mpeg' };
		}

		const bodyText = await res.text().catch(() => '');
		const upstream = extractMessage(bodyText) || `HTTP ${res.status}`;

		if (res.status === 429) {
			const wait = retryAfterSeconds(res, bodyText) ?? 15;
			if (!looksDaily(upstream) && waited + wait <= MAX_WAIT_S && attempt < 3) {
				await sleep(wait * 1000);
				waited += wait;
				continue;
			}
			throw error(429, {
				message: looksDaily(upstream)
					? `OpenRouter's free-model allowance for today is used up (50 requests/day per account, or 1,000 once the account has ever bought $10 of credit; resets at midnight UTC). Upstream: ${upstream}`
					: `OpenRouter is rate limiting this key (free models get 20 requests/min). Upstream: ${upstream}`,
				upstream,
				retryAfter: wait
			} as App.Error);
		}

		if (res.status === 401) {
			throw error(502, {
				message: `OpenRouter rejected the API key (${upstream}). Check OPENROUTER_API_KEY on the Worker.`,
				upstream
			} as App.Error);
		}
		if (res.status === 402) {
			throw error(429, {
				message: `OpenRouter says payment required — a paid model was selected, or the account balance is negative (free models stop working then too). Upstream: ${upstream}`,
				upstream
			} as App.Error);
		}
		if (res.status === 404 || res.status === 400) {
			throw error(502, {
				message: `OpenRouter did not accept the request for ${model} (voice "${voice}"): ${upstream}`,
				upstream
			} as App.Error);
		}

		// 5xx / provider outage: one more go after a moment, then report.
		if (attempt < 2 && res.status >= 500) {
			await sleep(600 * (attempt + 1));
			continue;
		}
		throw error(502, {
			message: `OpenRouter could not speak this chunk (${model}): ${upstream}`,
			upstream
		} as App.Error);
	}
	throw error(502, 'OpenRouter: out of retries');
}

/** OpenRouter and Google both wrap errors as { error: { message } }; keep the raw text otherwise. */
function extractMessage(bodyText: string): string {
	try {
		const j = JSON.parse(bodyText) as { error?: { message?: string; metadata?: unknown } | string; message?: string };
		if (typeof j.error === 'string') return j.error;
		if (j.error?.message) {
			const meta = j.error.metadata ? ` ${JSON.stringify(j.error.metadata).slice(0, 200)}` : '';
			return j.error.message + meta;
		}
		if (j.message) return j.message;
	} catch {
		/* not JSON */
	}
	return bodyText.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/* ─────────────────────────────── Gemini ─────────────────────────────── */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';

/**
 * Gemini TTS is steered by plain-language instructions in the prompt ("Say
 * cheerfully: …" in Google's own examples). The instruction is not spoken.
 * Keep it short and about delivery only — anything more and the model starts
 * ad-libbing.
 */
const GEMINI_STYLE = 'Read the following news brief aloud in a warm, clear, steady newsreader voice:\n\n';

export async function speakGemini(
	env: Env,
	{ text, voice }: { text: string; voice: string }
): Promise<Speech> {
	const key = env.GEMINI_API_KEY;
	if (!key) {
		throw error(503, {
			message:
				'The Gemini engine needs an API key on the server. Make one at aistudio.google.com/apikey (free, no card) and run: pnpm wrangler secret put GEMINI_API_KEY (no redeploy needed).'
		} as App.Error);
	}
	const model = env.GEMINI_TTS_MODEL || GEMINI_DEFAULT_MODEL;

	let waited = 0;
	for (let attempt = 0; attempt < 5; attempt++) {
		const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
			method: 'POST',
			headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
			body: JSON.stringify({
				contents: [{ parts: [{ text: GEMINI_STYLE + text }] }],
				generationConfig: {
					responseModalities: ['AUDIO'],
					speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
				}
			})
		});

		const bodyText = await res.text().catch(() => '');

		if (res.ok) {
			const audio = pickAudio(bodyText);
			if (audio) return audio;
			// Google documents this: "the model occasionally returns text tokens
			// instead of audio tokens … implement automated retry". Costs a request
			// from the daily 15, but the alternative is a silent gap.
			if (attempt < 2) continue;
			throw error(502, {
				message: `Gemini returned no audio for this chunk (${model}). Response: ${bodyText.slice(0, 200)}`
			} as App.Error);
		}

		const upstream = extractMessage(bodyText) || `HTTP ${res.status}`;

		if (res.status === 429) {
			const daily = looksDaily(bodyText);
			const wait = retryAfterSeconds(res, bodyText) ?? 20;
			if (!daily && waited + wait <= MAX_WAIT_S && attempt < 4) {
				await sleep(wait * 1000);
				waited += wait;
				continue;
			}
			throw error(429, {
				message: daily
					? `Gemini's free TTS allowance for today is used up (${model}: 15 requests/day on the free tier, resets at midnight Pacific). Upstream: ${upstream}`
					: `Gemini is rate limiting this key (free tier: 3 TTS requests/min). Upstream: ${upstream}`,
				upstream,
				retryAfter: wait
			} as App.Error);
		}

		if (res.status === 400 || res.status === 403) {
			throw error(502, {
				message: `Gemini rejected the request (${model}, voice "${voice}"): ${upstream}. A 400 about the model usually means it needs a different API version — try GEMINI_TTS_MODEL=${GEMINI_DEFAULT_MODEL}.`,
				upstream
			} as App.Error);
		}
		if (res.status === 404) {
			throw error(502, {
				message: `Gemini says model "${model}" doesn't exist for this key. Set GEMINI_TTS_MODEL in wrangler.jsonc to a TTS model (e.g. ${GEMINI_DEFAULT_MODEL}).`,
				upstream
			} as App.Error);
		}

		if (attempt < 3 && (res.status >= 500 || res.status === 408)) {
			await sleep(800 * (attempt + 1));
			continue;
		}
		throw error(502, {
			message: `Gemini could not speak this chunk (${model}): ${upstream}`,
			upstream
		} as App.Error);
	}
	throw error(502, 'Gemini: out of retries');
}

/**
 * generateContent returns the audio as base64 PCM in an inlineData part; the
 * mime type carries the rate ("audio/L16;codec=pcm;rate=24000"). Handed back
 * as raw little-endian 16-bit mono so the client can concatenate chunks and
 * write one WAV header — MP3 isn't on offer from this API.
 */
function pickAudio(bodyText: string): Speech | null {
	let json: {
		candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
	};
	try {
		json = JSON.parse(bodyText);
	} catch {
		return null;
	}
	for (const cand of json.candidates ?? []) {
		for (const part of cand.content?.parts ?? []) {
			const d = part.inlineData;
			if (!d?.data || !/^audio\//i.test(d.mimeType ?? '')) continue;
			const bin = atob(d.data);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			if (out.byteLength < 2) continue;
			const rate = Number(d.mimeType?.match(/rate=(\d+)/)?.[1]) || 24000;
			return { body: out, contentType: `audio/L16; rate=${rate}; channels=1` };
		}
	}
	return null;
}
