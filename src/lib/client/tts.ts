import type { Brief, Config } from '$lib/types';
import { chunkForTts } from '$lib/chunk';
import { CHUNK_CHARS } from '$lib/engines';
import { sanitizeForSpeech, isSpeakable } from '$lib/tts-text';
import { loadKokoro, generateKokoro, encodeWav, onKokoroDownload, kokoroStatus } from './kokoro';
import { authHeaders } from './uid';

export type Engine = Config['tts']['engine'];

export type RenderProgress = {
	done: number;
	total: number;
	engine: Engine;
	/** Chunks abandoned after retries. Non-fatal; the rest still plays. */
	skipped?: number;
	/** Set while the Kokoro weights are downloading, which dominates first use. */
	loading?: string;
};

export type RenderOptions = {
	onProgress?: (p: RenderProgress) => void;
	signal?: AbortSignal;
};

export type RenderResult = {
	blob: Blob;
	/** Chunks that never rendered. The audio is still playable without them. */
	skipped: number;
	/** Why they were dropped, for the UI to show rather than bury in the console. */
	reason?: string;
};

/**
 * How the brief is cut up depends on what's speaking it.
 *
 * Kokoro wants short pieces: StreamingKokoroJS caps at 300 with the note that
 * 400 "seems too long for kokoro", and long inputs are where it rushes and
 * slurs. Workers AI gets a segment at a time. The request-metered engines
 * (OpenRouter's free models, Gemini) get the opposite treatment — segments are
 * joined and cut as large as the upstream allows, because every request is one
 * of a small daily number and a sentence boundary sounds the same either way.
 */
function plan(brief: Brief, engine: Engine): string[] {
	const texts = brief.segments.map((s) => sanitizeForSpeech(s.text));
	if (engine === 'openrouter' || engine === 'gemini') {
		return chunkForTts(texts.join(' '), CHUNK_CHARS[engine]).filter(isSpeakable);
	}
	const max = engine === 'kokoro' ? 300 : undefined;
	return texts.flatMap((t) => chunkForTts(t, max)).filter(isSpeakable);
}

export async function renderBrief(
	brief: Brief,
	cfg: Config,
	opts: RenderOptions = {}
): Promise<RenderResult> {
	const chunks = plan(brief, cfg.tts.engine);
	if (chunks.length === 0) throw new Error('nothing to speak');

	return cfg.tts.engine === 'kokoro'
		? renderWithKokoro(chunks, cfg, opts)
		: renderOnServer(chunks, cfg, opts);
}

/** Human name for error messages and the progress line. */
export function engineLabel(engine: Engine): string {
	switch (engine) {
		case 'aura':
			return 'Deepgram Aura';
		case 'melotts':
			return 'MeloTTS';
		case 'kokoro':
			return 'Kokoro';
		case 'openrouter':
			return 'OpenRouter';
		case 'gemini':
			return 'Gemini';
	}
}

/** One request's worth of audio, tagged with what it is. */
type Part = { buf: ArrayBuffer; pcmRate?: number };

/** POST one chunk to /api/tts and hand back the bytes plus what they are. */
async function fetchSpeech(text: string, cfg: Config, signal?: AbortSignal): Promise<Part> {
	const res = await fetch('/api/tts', {
		method: 'POST',
		signal,
		headers: { 'content-type': 'application/json', ...authHeaders() },
		body: JSON.stringify({
			text,
			engine: cfg.tts.engine,
			lang: cfg.tts.lang,
			speaker: cfg.tts.auraSpeaker,
			model: cfg.tts.openrouterModel,
			voice: cfg.tts.engine === 'gemini' ? cfg.tts.geminiVoice : cfg.tts.openrouterVoice
		})
	});

	if (res.ok) {
		const type = res.headers.get('content-type') || '';
		// Gemini answers in raw 16-bit PCM ("audio/L16; rate=24000"); everything
		// else is MP3. Remember the rate so the WAV header can be right.
		const rate = /audio\/l16/i.test(type)
			? Number(type.match(/rate=(\d+)/)?.[1]) || 24000
			: undefined;
		return { buf: await res.arrayBuffer(), pcmRate: rate };
	}

	const detail = (await res.json().catch(() => ({}))) as {
		message?: string;
		upstream?: string;
	};
	// The route's own message already embeds the upstream text for the cloud
	// engines and says what to do about it; for Workers AI the raw upstream
	// string carries the error code and is the more useful of the two.
	const message =
		(cfg.tts.engine === 'openrouter' || cfg.tts.engine === 'gemini'
			? detail.message
			: detail.upstream || detail.message) || `speech failed with ${res.status}`;
	// Out of allowance, no key configured, or the engine is simply unavailable —
	// every remaining chunk will fail the same way, so stop rather than grind.
	if (res.status === 429 || res.status === 503) throw new FatalTtsError(message);
	throw new Error(message);
}

/**
 * Turn the collected parts into one playable Blob. MP3 frames concatenate
 * into a stream every browser plays; PCM needs a single WAV header on top.
 */
function assemble(parts: Part[]): Blob {
	const pcmRate = parts.find((p) => p.pcmRate)?.pcmRate;
	if (!pcmRate) return new Blob(parts.map((p) => p.buf), { type: 'audio/mpeg' });
	const pcm = parts.filter((p) => p.pcmRate).map((p) => p.buf);
	return wavFromPcm16(pcm, pcmRate);
}

/** Wrap little-endian 16-bit mono PCM buffers in a WAV container without copying the samples twice. */
export function wavFromPcm16(chunks: ArrayBuffer[], sampleRate: number): Blob {
	const bytes = chunks.reduce((n, c) => n + c.byteLength - (c.byteLength % 2), 0);
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, 'RIFF');
	view.setUint32(4, 36 + bytes, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, 'data');
	view.setUint32(40, bytes, true);
	// Drop a stray odd byte rather than shift every later sample by 8 bits.
	const even = chunks.map((c) => (c.byteLength % 2 ? c.slice(0, c.byteLength - 1) : c));
	return new Blob([header, ...even], { type: 'audio/wav' });
}

/**
 * A few seconds of the configured server voice, for the Settings page. Costs
 * one request of whatever the engine's allowance is.
 */
export async function previewServerVoice(cfg: Config, text: string): Promise<Blob> {
	const part = await fetchSpeech(text, cfg);
	return assemble([part]);
}

/** Thrown for failures where continuing is pointless, e.g. allowance exhausted. */
class FatalTtsError extends Error {}

/** Server-side path: one /api/tts call per chunk, parts concatenated at the end. */
async function renderOnServer(
	chunks: string[],
	cfg: Config,
	opts: RenderOptions
): Promise<RenderResult> {
	const engine = cfg.tts.engine;
	const parts = new Array<Part[]>(chunks.length);
	let done = 0;
	let next = 0;
	let skipped = 0;
	/** Why chunks were abandoned, most frequent first. Without this the failure
	 *  message says only "every chunk failed" and the cause dies in the console. */
	const reasons = new Map<string, number>();

	const speak = (text: string) => fetchSpeech(text, cfg, opts.signal);

	/**
	 * Workers AI returns opaque upstream errors (3043) often enough that losing
	 * the whole brief to one bad chunk is unacceptable. Halve and retry, then give up
	 * on just that fragment — a brief missing one sentence still beats no brief.
	 * The request-metered engines get one halving at most: each retry is a
	 * request off a daily allowance of 15 or 50.
	 */
	const maxDepth = engine === 'openrouter' || engine === 'gemini' ? 1 : 2;
	async function speakWithFallback(text: string, depth = 0): Promise<Part[]> {
		try {
			return [await speak(text)];
		} catch (e) {
			if (e instanceof FatalTtsError) throw e;
			if (opts.signal?.aborted) throw e;

			if (depth < maxDepth && text.length > 120) {
				const middle = text.lastIndexOf(' ', Math.floor(text.length / 2));
				const at = middle > 40 ? middle : Math.floor(text.length / 2);
				const left = text.slice(0, at).trim();
				const right = text.slice(at).trim();
				const [a, b] = await Promise.all([
					speakWithFallback(left, depth + 1),
					speakWithFallback(right, depth + 1)
				]);
				return [...a, ...b];
			}

			skipped++;
			const reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
			reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
			return [];
		}
	}

	const summariseReasons = () =>
		[...reasons.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 2)
			.map(([reason, n]) => (n > 1 ? `${reason} (×${n})` : reason))
			.join('; ');

	const worker = async () => {
		for (;;) {
			const i = next++;
			if (i >= chunks.length) return;
			parts[i] = await speakWithFallback(chunks[i]);
			done++;
			opts.onProgress?.({ done, total: chunks.length, engine, skipped });
		}
	};

	// Three at a time: enough to keep it moving, not enough to look like abuse.
	// Gemini's free tier allows 3 requests a minute, each of which takes a good
	// part of a minute to render three minutes of speech — one at a time, and
	// the server waits out any per-minute 429 in place.
	const concurrency = engine === 'gemini' ? 1 : 3;
	await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));

	const flat = parts.flat().filter(Boolean);
	if (flat.length === 0) {
		throw new Error(
			`All ${chunks.length} chunks failed. ${engineLabel(engine)} said: ${summariseReasons() || 'no reason given'}. ` +
				'Try a different engine in Settings — Kokoro renders on your device and depends on nothing upstream.'
		);
	}

	return { blob: assemble(flat), skipped, reason: summariseReasons() };
}

/**
 * On-device path. Costs nothing and works offline, at the price of a one-time
 * model download. Inference happens in a worker so the tab stays usable.
 */
async function renderWithKokoro(
	chunks: string[],
	cfg: Config,
	opts: RenderOptions
): Promise<RenderResult> {
	opts.onProgress?.({
		done: 0,
		total: chunks.length,
		engine: 'kokoro',
		loading: 'Loading voice model…'
	});

	// Downloading the weights dominates first use, so report it rather than
	// looking frozen.
	onKokoroDownload((fraction) =>
		opts.onProgress?.({
			done: 0,
			total: chunks.length,
			engine: 'kokoro',
			loading: `Downloading voice model… ${Math.round(fraction * 100)}%`
		})
	);

	try {
		await loadKokoro(cfg.tts.kokoroMode || undefined);
	} finally {
		onKokoroDownload(null);
	}

	const pcm: Float32Array[] = [];
	let rate = 24000;
	let skipped = 0;
	let reason = '';

	for (const [i, chunk] of chunks.entries()) {
		if (opts.signal?.aborted) throw new Error('cancelled');
		try {
			const out = await generateKokoro(chunk, cfg.tts.kokoroVoice, cfg.tts.kokoroMode || undefined);
			pcm.push(out.pcm);
			rate = out.rate;
		} catch (e) {
			// One unpronounceable fragment shouldn't cost the whole brief, but the
			// reason still has to reach the surface.
			skipped++;
			reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		}
		opts.onProgress?.({ done: i + 1, total: chunks.length, engine: 'kokoro', skipped });
	}

	if (pcm.length === 0) {
		const where = kokoroStatus();
		throw new Error(
			`Kokoro produced no audio (${where?.device ?? 'unknown backend'}/${where?.dtype ?? '?'}). ` +
				`Last error: ${reason || 'none reported'}`
		);
	}
	return { blob: encodeWav(pcm, rate), skipped, reason };
}
