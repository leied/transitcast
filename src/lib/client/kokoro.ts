/**
 * Kokoro model loading and the voice catalogue.
 *
 * Grades come from the model card's VOICES.md and estimate the quality and
 * quantity of each voice's training data — they are not opinions about timbre,
 * but they predict artefacts well, and the spread is wide: af_heart is an A
 * while am_adam is an F+. Worth showing, because picking blind from a list of
 * 50 is how you end up with a voice that sounds broken.
 */
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

	// Other languages. The brief itself is written in English, so these only make
	// sense alongside a section prompt that asks for another language.
	{ id: 'ff_siwis', name: 'Siwis', group: 'French', gender: 'F', grade: 'B-' },
	{ id: 'jf_alpha', name: 'Alpha', group: 'Japanese', gender: 'F', grade: 'C+' },
	{ id: 'jf_gongitsune', name: 'Gongitsune', group: 'Japanese', gender: 'F', grade: 'C' },
	{ id: 'jf_tebukuro', name: 'Tebukuro', group: 'Japanese', gender: 'F', grade: 'C' },
	{ id: 'jf_nezumi', name: 'Nezumi', group: 'Japanese', gender: 'F', grade: 'C-' },
	{ id: 'jm_kumo', name: 'Kumo', group: 'Japanese', gender: 'M', grade: 'C-' },
	{ id: 'hf_alpha', name: 'Alpha', group: 'Hindi', gender: 'F', grade: 'C' },
	{ id: 'hf_beta', name: 'Beta', group: 'Hindi', gender: 'F', grade: 'C' },
	{ id: 'hm_omega', name: 'Omega', group: 'Hindi', gender: 'M', grade: 'C' },
	{ id: 'hm_psi', name: 'Psi', group: 'Hindi', gender: 'M', grade: 'C' },
	{ id: 'if_sara', name: 'Sara', group: 'Italian', gender: 'F', grade: 'C' },
	{ id: 'im_nicola', name: 'Nicola', group: 'Italian', gender: 'M', grade: 'C' },
	{ id: 'ef_dora', name: 'Dora', group: 'Spanish', gender: 'F', grade: '—' },
	{ id: 'em_alex', name: 'Alex', group: 'Spanish', gender: 'M', grade: '—' },
	{ id: 'pf_dora', name: 'Dora', group: 'Brazilian Portuguese', gender: 'F', grade: '—' },
	{ id: 'pm_alex', name: 'Alex', group: 'Brazilian Portuguese', gender: 'M', grade: '—' },
	{ id: 'zf_xiaoxiao', name: 'Xiaoxiao', group: 'Mandarin Chinese', gender: 'F', grade: 'D' },
	{ id: 'zm_yunyang', name: 'Yunyang', group: 'Mandarin Chinese', gender: 'M', grade: 'D' }
];

export const VOICE_GROUPS = [...new Set(KOKORO_VOICES.map((v) => v.group))];

export function voicesIn(group: string): KokoroVoice[] {
	return KOKORO_VOICES.filter((v) => v.group === group).sort((a, b) => {
		const byGrade = GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade);
		return byGrade !== 0 ? byGrade : a.name.localeCompare(b.name);
	});
}

export function voiceLabel(v: KokoroVoice): string {
	const bits = [`${v.name} (${v.gender})`, v.grade === '—' ? 'ungraded' : `grade ${v.grade}`];
	if (v.note) bits.push(v.note);
	return bits.join(' · ');
}

type Kokoro = { generate(text: string, opts: { voice: string }): Promise<AudioLike> };
type AudioLike = { audio: Float32Array; sampling_rate: number };

let cached: Promise<Kokoro> | null = null;

/**
 * Loads the model once per page. q8 is the 92MB `model_quantized.onnx`; the
 * upstream README suggests fp32 on WebGPU but that file is 326MB, which is not
 * something to pull onto a phone. WebGPU is refused on plenty of mobile
 * browsers even when navigator.gpu exists, hence the fallback.
 */
export function loadKokoro(): Promise<Kokoro> {
	cached ??= (async () => {
		const { KokoroTTS } = await import('kokoro-js');
		const load = (device: 'webgpu' | 'wasm') =>
			KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device });
		try {
			return (await load('gpu' in navigator ? 'webgpu' : 'wasm')) as unknown as Kokoro;
		} catch {
			try {
				return (await load('wasm')) as unknown as Kokoro;
			} catch (inner) {
				cached = null; // let a later attempt retry rather than reuse the failure
				const detail = inner instanceof Error ? inner.message : String(inner);
				throw new Error(
					`Couldn't load the Kokoro voice model (${detail}). It downloads about 92MB from huggingface.co on first use — check the network isn't blocking it, then try again.`
				);
			}
		}
	})();
	return cached;
}

export const SAMPLE_TEXT =
	'Good morning. Markets opened lower after the central bank held rates steady, and transit riders face delays on three routes downtown.';

/** Renders a short sample so a voice can be judged before committing to it. */
export async function previewVoice(voice: string): Promise<Blob> {
	const tts = await loadKokoro();
	const audio = await tts.generate(SAMPLE_TEXT, { voice });
	return encodeWav([audio.audio], audio.sampling_rate);
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
