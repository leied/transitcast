import type { Brief, Config } from '$lib/types';
import { chunkForTts } from '$lib/chunk';
import { sanitizeForSpeech, isSpeakable } from '$lib/tts-text';
import { authHeaders } from './uid';

export type RenderProgress = {
	done: number;
	total: number;
	engine: 'melotts' | 'kokoro';
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

function plan(brief: Brief): string[] {
	return brief.segments
		.flatMap((s) => chunkForTts(sanitizeForSpeech(s.text)))
		.filter(isSpeakable);
}

export async function renderBrief(
	brief: Brief,
	cfg: Config,
	opts: RenderOptions = {}
): Promise<RenderResult> {
	const chunks = plan(brief);
	if (chunks.length === 0) throw new Error('nothing to speak');

	return cfg.tts.engine === 'kokoro'
		? renderWithKokoro(chunks, cfg, opts)
		: renderWithMeloTts(chunks, cfg, opts);
}

/** Thrown for failures where continuing is pointless, e.g. allowance exhausted. */
class FatalTtsError extends Error {}

/** Server-side path: one Workers AI call per chunk, MP3 parts concatenated. */
async function renderWithMeloTts(
	chunks: string[],
	cfg: Config,
	opts: RenderOptions
): Promise<RenderResult> {
	const parts = new Array<ArrayBuffer[]>(chunks.length);
	let done = 0;
	let next = 0;
	let skipped = 0;
	/** Why chunks were abandoned, most frequent first. Without this the failure
	 *  message says only "every chunk failed" and the cause dies in the console. */
	const reasons = new Map<string, number>();

	async function speak(text: string): Promise<ArrayBuffer> {
		const res = await fetch('/api/tts', {
			method: 'POST',
			signal: opts.signal,
			headers: { 'content-type': 'application/json', ...authHeaders() },
			body: JSON.stringify({ text, lang: cfg.tts.lang })
		});

		if (res.ok) return res.arrayBuffer();

		const detail = (await res.json().catch(() => ({}))) as {
			message?: string;
			upstream?: string;
		};
		// Prefer the verbatim upstream text; it carries the Workers AI error code.
		const message = detail.upstream || detail.message || `speech failed with ${res.status}`;
		// Out of allowance, or the engine is simply unavailable — every remaining
		// chunk will fail the same way, so stop rather than grind through them.
		if (res.status === 429) throw new FatalTtsError(message);
		throw new Error(message);
	}

	/**
	 * MeloTTS returns opaque upstream errors (3043) often enough that losing the
	 * whole brief to one bad chunk is unacceptable. Halve and retry, then give up
	 * on just that fragment — a brief missing one sentence still beats no brief.
	 */
	async function speakWithFallback(text: string, depth = 0): Promise<ArrayBuffer[]> {
		try {
			return [await speak(text)];
		} catch (e) {
			if (e instanceof FatalTtsError) throw e;
			if (opts.signal?.aborted) throw e;

			if (depth < 2 && text.length > 120) {
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
			opts.onProgress?.({ done, total: chunks.length, engine: 'melotts', skipped });
		}
	};

	// Three at a time: enough to keep it moving, not enough to look like abuse.
	await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));

	const flat = parts.flat().filter(Boolean);
	if (flat.length === 0) {
		throw new Error(
			`All ${chunks.length} chunks failed. Workers AI said: ${summariseReasons() || 'no reason given'}. ` +
				'If this persists, switch the engine to Kokoro in Settings to render on your device instead.'
		);
	}

	// Concatenated MP3 frames play back as one stream in every browser engine.
	return { blob: new Blob(flat, { type: 'audio/mpeg' }), skipped, reason: summariseReasons() };
}

/**
 * On-device path. Costs nothing and works offline, at the price of a ~92MB
 * one-time model download (cached by the browser afterwards).
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
		loading: 'Downloading voice model…'
	});

	const { KokoroTTS } = await import('kokoro-js');

	// q8 is the 92MB `model_quantized.onnx`. The upstream README suggests fp32 on
	// WebGPU, but that file is 326MB — not something to pull onto a phone that's
	// about to get on a bus.
	const load = (device: 'webgpu' | 'wasm') =>
		KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device });

	let tts;
	try {
		tts = await load('gpu' in navigator ? 'webgpu' : 'wasm');
	} catch (e) {
		// WebGPU is refused on plenty of mobile browsers even when navigator.gpu
		// exists, so fall back rather than giving up.
		try {
			tts = await load('wasm');
		} catch (inner) {
			const detail = inner instanceof Error ? inner.message : String(inner);
			throw new Error(
				`Couldn't load the Kokoro voice model (${detail}). It downloads about 92MB from huggingface.co on first use — check that the network isn't blocking it, then try again.`
			);
		}
	}

	const pcm: Float32Array[] = [];
	let rate = 24000;
	let skipped = 0;
	let reason = '';

	for (const [i, chunk] of chunks.entries()) {
		if (opts.signal?.aborted) throw new Error('cancelled');
		try {
			const audio = await tts.generate(chunk, { voice: cfg.tts.kokoroVoice as never });
			pcm.push(audio.audio as Float32Array);
			rate = audio.sampling_rate;
		} catch (e) {
			// One unpronounceable fragment shouldn't cost the whole brief, but the
			// reason still has to reach the surface.
			skipped++;
			reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		}
		opts.onProgress?.({ done: i + 1, total: chunks.length, engine: 'kokoro', skipped });
	}

	if (pcm.length === 0) {
		throw new Error(`Kokoro produced no audio. Last error: ${reason || 'none reported'}`);
	}
	return { blob: encodeWav(pcm, rate), skipped, reason };
}

/**
 * Kokoro returns raw samples per chunk. WAV files can't just be concatenated
 * the way MP3 frames can, so the PCM is joined and a single header written.
 */
function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
	const length = chunks.reduce((n, c) => n + c.length, 0);
	const buffer = new ArrayBuffer(44 + length * 2);
	const view = new DataView(buffer);

	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};

	ascii(0, 'RIFF');
	view.setUint32(4, 36 + length * 2, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true); // PCM header size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, 'data');
	view.setUint32(40, length * 2, true);

	let offset = 44;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			const s = Math.max(-1, Math.min(1, chunk[i]));
			view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
			offset += 2;
		}
	}

	return new Blob([buffer], { type: 'audio/wav' });
}
