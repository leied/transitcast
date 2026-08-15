/// <reference lib="webworker" />
import { KokoroTTS } from 'kokoro-js';

/**
 * Kokoro runs here, not on the main thread.
 *
 * Synthesising a six-minute brief is minutes of solid compute; on the main
 * thread that freezes the tab and can get it killed outright. Every reference
 * implementation (StreamingKokoroJS, HeadTTS) puts the model in a worker.
 */

type LoadRequest = { id: number; type: 'load'; dtype?: Dtype };
type GenerateRequest = { id: number; type: 'generate'; text: string; voice: string; dtype?: Dtype };
type Request = LoadRequest | GenerateRequest;
type Dtype = 'fp32' | 'fp16' | 'q4f16' | 'q8';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

async function hasWebGPU(): Promise<boolean> {
	try {
		const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
		if (!gpu) return false;
		return !!(await gpu.requestAdapter());
	} catch {
		return false;
	}
}

let loading: Promise<{ tts: KokoroTTS; device: string; dtype: Dtype }> | null = null;

function load(preferred?: Dtype) {
	loading ??= (async () => {
		// Asking for the adapter is the real test — navigator.gpu exists on plenty
		// of mobile browsers that then refuse to hand one over.
		const device: 'webgpu' | 'wasm' = (await hasWebGPU()) ? 'webgpu' : 'wasm';

		// The dtype must match the backend. int8 weights on the WebGPU backend
		// produce audible noise rather than speech — kokoro-js's own README says
		// q8 and q4 "are not recommended for this model", and every reference
		// implementation picks fp32 for WebGPU and reserves q8 for WASM.
		const dtype: Dtype = preferred ?? (device === 'webgpu' ? 'fp32' : 'q8');

		self.postMessage({ type: 'status', device, dtype });

		const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
			dtype,
			device,
			progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
				if (p?.status === 'progress' && typeof p.progress === 'number') {
					self.postMessage({ type: 'progress', progress: p.progress, file: p.file });
				}
			}
		});
		return { tts, device, dtype };
	})().catch((e) => {
		loading = null; // let a retry actually retry
		throw e;
	});
	return loading;
}

self.onmessage = async (event: MessageEvent<Request>) => {
	const msg = event.data;
	try {
		if (msg.type === 'load') {
			const { device, dtype } = await load(msg.dtype);
			self.postMessage({ id: msg.id, ok: true, device, dtype });
			return;
		}

		const { tts } = await load(msg.dtype);
		const audio = await tts.generate(msg.text, { voice: msg.voice as never });
		const pcm = audio.audio as Float32Array;
		// Transfer rather than copy; these buffers are megabytes each.
		self.postMessage({ id: msg.id, ok: true, pcm, rate: audio.sampling_rate }, [pcm.buffer]);
	} catch (e) {
		self.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
	}
};
