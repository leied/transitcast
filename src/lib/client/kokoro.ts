/**
 * Kokoro model loading and the voice catalogue.
 *
 * Grades come from the model card's VOICES.md and estimate the quality and
 * quantity of each voice's training data — they are not opinions about timbre,
 * but they predict artefacts well, and the spread is wide: af_heart is an A
 * while am_adam is an F+. Worth showing, because picking blind from a list of
 * 50 is how you end up with a voice that sounds broken.
 */
import { sanitizeForSpeech } from '$lib/tts-text';

export type KokoroVoice = {
	id: string;
	name: string;
	group: string;
	gender: 'F' | 'M';
	grade: string;
	note?: string;
};

const GRADE_ORDER = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];

export const KOKORO_VOICES: KokoroVoice[] = [
	// American English
	{ id: 'af_heart', name: 'Heart', group: 'American English', gender: 'F', grade: 'A', note: 'best overall' },
	{ id: 'af_bella', name: 'Bella', group: 'American English', gender: 'F', grade: 'A-', note: 'most training data' },
	{ id: 'af_nicole', name: 'Nicole', group: 'American English', gender: 'F', grade: 'B-', note: 'headphone-ish' },
	{ id: 'af_aoede', name: 'Aoede', group: 'American English', gender: 'F', grade: 'C+' },
	{ id: 'af_kore', name: 'Kore', group: 'American English', gender: 'F', grade: 'C+' },
	{ id: 'af_sarah', name: 'Sarah', group: 'American English', gender: 'F', grade: 'C+' },
	{ id: 'af_alloy', name: 'Alloy', group: 'American English', gender: 'F', grade: 'C' },
	{ id: 'af_nova', name: 'Nova', group: 'American English', gender: 'F', grade: 'C' },
	{ id: 'af_sky', name: 'Sky', group: 'American English', gender: 'F', grade: 'C-' },
	{ id: 'af_jessica', name: 'Jessica', group: 'American English', gender: 'F', grade: 'D' },
	{ id: 'af_river', name: 'River', group: 'American English', gender: 'F', grade: 'D' },
	{ id: 'am_fenrir', name: 'Fenrir', group: 'American English', gender: 'M', grade: 'C+' },
	{ id: 'am_michael', name: 'Michael', group: 'American English', gender: 'M', grade: 'C+' },
	{ id: 'am_puck', name: 'Puck', group: 'American English', gender: 'M', grade: 'C+' },
	{ id: 'am_echo', name: 'Echo', group: 'American English', gender: 'M', grade: 'D' },
	{ id: 'am_eric', name: 'Eric', group: 'American English', gender: 'M', grade: 'D' },
	{ id: 'am_liam', name: 'Liam', group: 'American English', gender: 'M', grade: 'D' },
	{ id: 'am_onyx', name: 'Onyx', group: 'American English', gender: 'M', grade: 'D' },
	{ id: 'am_santa', name: 'Santa', group: 'American English', gender: 'M', grade: 'D-' },
	{ id: 'am_adam', name: 'Adam', group: 'American English', gender: 'M', grade: 'F+' },

	// British English
	{ id: 'bf_emma', name: 'Emma', group: 'British English', gender: 'F', grade: 'B-' },
	{ id: 'bf_isabella', name: 'Isabella', group: 'British English', gender: 'F', grade: 'C' },
	{ id: 'bf_alice', name: 'Alice', group: 'British English', gender: 'F', grade: 'D' },
	{ id: 'bf_lily', name: 'Lily', group: 'British English', gender: 'F', grade: 'D' },
	{ id: 'bm_fable', name: 'Fable', group: 'British English', gender: 'M', grade: 'C' },
	{ id: 'bm_george', name: 'George', group: 'British English', gender: 'M', grade: 'C' },
	{ id: 'bm_lewis', name: 'Lewis', group: 'British English', gender: 'M', grade: 'D+' },
	{ id: 'bm_daniel', name: 'Daniel', group: 'British English', gender: 'M', grade: 'D' },

	// Only these 28 exist in kokoro-js. The Hugging Face repo ships voice files
	// for French, Japanese, Hindi, Italian, Spanish, Portuguese and Mandarin too,
	// but the library's voice table doesn't list them and generate() throws
	// "Voice not found" — listing them from the repo's file names was a mistake.
];

export const VOICE_GROUPS = [...new Set(KOKORO_VOICES.map((v) => v.group))];

export function voicesIn(group: string): KokoroVoice[] {
	return KOKORO_VOICES.filter((v) => v.group === group).sort((a, b) => {
		const byGrade = GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade);
		return byGrade !== 0 ? byGrade : a.name.localeCompare(b.name);
	});
}

export function voiceLabel(v: KokoroVoice): string {
	const bits = [`${v.name} (${v.gender})`, `grade ${v.grade}`];
	if (v.note) bits.push(v.note);
	return bits.join(' · ');
}

export type KokoroStatus = { device: string; dtype: string };

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let status: KokoroStatus | null = null;
let onDownload: ((fraction: number) => void) | null = null;

/** Fraction 0-1 of the model download, or null once loaded. */
export function onKokoroDownload(cb: ((fraction: number) => void) | null) {
	onDownload = cb;
}

export function kokoroStatus(): KokoroStatus | null {
	return status;
}

function ensureWorker(): Worker {
	if (worker) return worker;
	worker = new Worker(new URL('./kokoro-worker.ts', import.meta.url), { type: 'module' });
	worker.onmessage = (e: MessageEvent) => {
		const d = e.data;
		if (d?.type === 'status') {
			status = { device: d.device, dtype: d.dtype };
			return;
		}
		if (d?.type === 'progress') {
			onDownload?.(Math.max(0, Math.min(1, (d.progress ?? 0) / 100)));
			return;
		}
		const p = pending.get(d?.id);
		if (!p) return;
		pending.delete(d.id);
		if (d.ok) p.resolve(d as never);
		else p.reject(new Error(d.error || 'Kokoro worker failed'));
	};
	worker.onerror = (e) => {
		for (const [, p] of pending) p.reject(new Error(e.message || 'Kokoro worker crashed'));
		pending.clear();
		worker?.terminate();
		worker = null;
	};
	return worker;
}

function call<T>(payload: Record<string, unknown>): Promise<T> {
	const w = ensureWorker();
	const id = nextId++;
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: resolve as never, reject });
		w.postMessage({ id, ...payload });
	});
}

/**
 * Loads the model in a worker. dtype is chosen there to match the backend:
 * int8 weights on WebGPU synthesise noise instead of speech, which is the
 * single most important thing this file gets right.
 */
export async function loadKokoro(mode?: string): Promise<void> {
	try {
		await call<{ device: string; dtype: string }>({ type: 'load', mode });
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		throw new Error(
			`Couldn't load the Kokoro voice model (${detail}). It downloads from huggingface.co on first use — check the network isn't blocking it, then try again.`
		);
	}
}

export async function generateKokoro(
	text: string,
	voice: string,
	mode?: string
): Promise<{ pcm: Float32Array; rate: number }> {
	const r = await call<{ pcm: Float32Array; rate: number }>({
		type: 'generate',
		text,
		voice,
		mode
	});
	return { pcm: r.pcm, rate: r.rate };
}

export const SAMPLE_TEXT =
	'Good morning. Markets opened lower after the central bank held rates steady, and transit riders face delays on three routes downtown.';

/** Renders a short sample so a voice can be judged before committing to it. */
export async function previewVoice(voice: string, mode?: string): Promise<Blob> {
	// Same treatment the brief gets, so the audition matches the real thing.
	const { pcm, rate } = await generateKokoro(sanitizeForSpeech(SAMPLE_TEXT), voice, mode);
	return encodeWav([pcm], rate);
}

/**
 * Kokoro returns raw samples per chunk. WAV files can't be concatenated the way
 * MP3 frames can, so the PCM is joined and a single header written.
 */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
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
