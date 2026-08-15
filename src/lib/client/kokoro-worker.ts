/// <reference lib="webworker" />
import { KokoroTTS } from 'kokoro-js';

/**
 * Kokoro runs here, not on the main thread.
 *
 * Synthesising a six-minute brief is minutes of solid compute; on the main
 * thread that freezes the tab and can get it killed outright. Every reference
 * implementation (StreamingKokoroJS, HeadTTS) puts the model in a worker.
 */

type LoadRequest = { id: number; type: 'load'; mode?: string };
type GenerateRequest = { id: number; type: 'generate'; text: string; voice: string; mode?: string };
type Request = LoadRequest | GenerateRequest;
type Dtype = 'fp32' | 'fp16' | 'q4f16' | 'q8';
type Device = 'webgpu' | 'wasm';

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

/**
 * Backend and precision are one decision, not two: q8 only makes sense on
 * WASM, and fp32 is what the WebGPU path expects. Pairing them in a single
 * setting stops anyone assembling a combination that produces noise.
 */
function resolveMode(mode: string | undefined, canWebGPU: boolean): { device: Device; dtype: Dtype } {
	switch (mode) {
		case 'webgpu-fp32':
			return { device: 'webgpu', dtype: 'fp32' };
		case 'webgpu-q4f16':
			return { device: 'webgpu', dtype: 'q4f16' };
		case 'wasm-q8':
			return { device: 'wasm', dtype: 'q8' };
		case 'wasm-fp32':
			return { device: 'wasm', dtype: 'fp32' };
		default:
			// WASM by default even when WebGPU is available. On an Intel Xe-LPG
			// adapter the WebGPU backend scored 0.407 back/front (reference 0.99)
			// at fp32 and produced pure silence at q4f16, while both WASM paths
			// were clean. There's no way to detect a bad adapter up front, so the
			// automatic choice is the one that is correct everywhere.
			return { device: 'wasm', dtype: 'q8' };
	}
}

function load(mode?: string) {
	loading ??= (async () => {
		// Asking for the adapter is the real test — navigator.gpu exists on plenty
		// of mobile browsers that then refuse to hand one over.
		const { device, dtype } = resolveMode(mode, await hasWebGPU());
		const threads = self.crossOriginIsolated ? 'multi' : 'single';

		self.postMessage({ type: 'status', device, dtype, threads });

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
			const { device, dtype } = await load(msg.mode);
			self.postMessage({ id: msg.id, ok: true, device, dtype });
			return;
		}

		const { tts } = await load(msg.mode);
		const audio = await tts.generate(msg.text, { voice: msg.voice as never });
		const pcm = audio.audio as Float32Array;
		// Transfer rather than copy; these buffers are megabytes each.
		self.postMessage({ id: msg.id, ok: true, pcm, rate: audio.sampling_rate }, [pcm.buffer]);
	} catch (e) {
		self.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
	}
};
