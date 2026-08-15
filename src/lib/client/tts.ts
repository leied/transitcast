import type { Brief, Config } from '$lib/types';
import { chunkForTts } from '$lib/chunk';
import { authHeaders } from './uid';

export type RenderProgress = {
	done: number;
	total: number;
	engine: 'melotts' | 'kokoro';
	/** Set while the Kokoro weights are downloading, which dominates first use. */
	loading?: string;
};

export type RenderOptions = {
	onProgress?: (p: RenderProgress) => void;
	signal?: AbortSignal;
};

function plan(brief: Brief): string[] {
	return brief.segments.flatMap((s) => chunkForTts(s.text));
}

export async function renderBrief(
	brief: Brief,
	cfg: Config,
	opts: RenderOptions = {}
): Promise<Blob> {
	const chunks = plan(brief);
	if (chunks.length === 0) throw new Error('nothing to speak');

	return cfg.tts.engine === 'kokoro'
		? renderWithKokoro(chunks, cfg, opts)
		: renderWithMeloTts(chunks, cfg, opts);
}

/** Server-side path: one Workers AI call per chunk, MP3 parts concatenated. */
async function renderWithMeloTts(
	chunks: string[],
	cfg: Config,
	opts: RenderOptions
): Promise<Blob> {
	const parts = new Array<ArrayBuffer>(chunks.length);
	let done = 0;
	let next = 0;

	const worker = async () => {
		for (;;) {
			const i = next++;
			if (i >= chunks.length) return;

			const res = await fetch('/api/tts', {
				method: 'POST',
				signal: opts.signal,
				headers: { 'content-type': 'application/json', ...authHeaders() },
				body: JSON.stringify({ text: chunks[i], lang: cfg.tts.lang })
			});

			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as { message?: string };
				throw new Error(detail.message || `speech failed with ${res.status}`);
			}

			parts[i] = await res.arrayBuffer();
			done++;
			opts.onProgress?.({ done, total: chunks.length, engine: 'melotts' });
		}
	};

	// Three at a time: enough to keep it moving, not enough to look like abuse.
	await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));

	// Concatenated MP3 frames play back as one stream in every browser engine.
	return new Blob(parts, { type: 'audio/mpeg' });
}

/**
 * On-device path. Costs nothing and works offline, at the price of a ~92MB
 * one-time model download (cached by the browser afterwards).
 */
async function renderWithKokoro(
	chunks: string[],
	cfg: Config,
	opts: RenderOptions
): Promise<Blob> {
	opts.onProgress?.({ done: 0, total: chunks.length, engine: 'kokoro', loading: 'Loading voice model…' });

	const { KokoroTTS } = await import('kokoro-js');
	const hasWebGPU = 'gpu' in navigator;
	const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
		dtype: hasWebGPU ? 'fp32' : 'q8',
		device: hasWebGPU ? 'webgpu' : 'wasm'
	});

	const pcm: Float32Array[] = [];
	let rate = 24000;

	for (const [i, chunk] of chunks.entries()) {
		if (opts.signal?.aborted) throw new Error('cancelled');
		const audio = await tts.generate(chunk, { voice: cfg.tts.kokoroVoice as never });
		pcm.push(audio.audio as Float32Array);
		rate = audio.sampling_rate;
		opts.onProgress?.({ done: i + 1, total: chunks.length, engine: 'kokoro' });
	}

	return encodeWav(pcm, rate);
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
