/// <reference lib="webworker" />
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

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

/**
 * Hugging Face refuses downloads whose Referer is a *.workers.dev host, and a
 * worker does not inherit the page's <meta name="referrer"> — it sends the
 * browser default, which is the origin. Measured: from a workers.dev origin the
 * default policy fails outright ("Failed to fetch"), no-referrer gets 200.
 * transformers.js and kokoro-js both use the global fetch, so wrap it once.
 */
const realFetch = self.fetch.bind(self);
self.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
	realFetch(input, { referrerPolicy: 'no-referrer', ...init })) as typeof fetch;

/**
 * ARM cores run Kokoro's int8 kernels 2.5-3x slower than fp32 (measured on
 * Snapdragon X in Chrome and Node); x86 barely cares. So the automatic choice
 * takes the 326MB fp32 model on ARM laptops/desktops, and the 92MB q8 model
 * everywhere else. Phones keep q8: the download matters more there.
 */
async function prefersFp32(): Promise<boolean> {
	const uaData = (
		navigator as Navigator & {
			userAgentData?: { mobile?: boolean; getHighEntropyValues?(h: string[]): Promise<{ architecture?: string }> };
		}
	).userAgentData;
	if (uaData?.mobile) return false;
	if (/iPhone|iPad|Android/.test(navigator.userAgent)) return false;
	try {
		const arch = (await uaData?.getHighEntropyValues?.(['architecture']))?.architecture;
		if (arch) return arch === 'arm';
	} catch {
		/* Safari has no UA-CH; fall through */
	}
	// Safari: every Mac sold since 2020 is Apple silicon.
	return /Macintosh/.test(navigator.userAgent);
}

let loading: Promise<{ tts: KokoroTTS; device: string; dtype: Dtype }> | null = null;

/**
 * Backend and precision are one decision, not two: q8 only makes sense on
 * WASM, and fp32 is what the WebGPU path expects. Pairing them in a single
 * setting stops anyone assembling a combination that produces noise.
 */
async function resolveMode(mode: string | undefined): Promise<{ device: Device; dtype: Dtype }> {
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
			// WASM by default even when WebGPU is available. On Intel Xe-LPG the
			// WebGPU backend drops the level mid-clip (gain 1.13 → 0.43 vs the CPU
			// reference) with both the JSEP and native ORT WebGPU backends, and
			// q4f16 comes out as NaN. There's no way to detect a bad adapter up
			// front, so the automatic choice is the one that is correct everywhere.
			return { device: 'wasm', dtype: (await prefersFp32()) ? 'fp32' : 'q8' };
	}
}

/**
 * onnxruntime-web caps itself at min(4, cores/2) threads. On a 22-core laptop
 * that's RTF 2.8; ceil(cores/2) measured 1.56 and every core 1.81 (SMT
 * contention), so half the cores it is. Only meaningful when cross-origin
 * isolated — without SharedArrayBuffer ORT forces 1 anyway.
 */
function configureThreads(): number {
	const cores = navigator.hardwareConcurrency || 4;
	const wanted = self.crossOriginIsolated ? Math.max(1, Math.ceil(cores / 2)) : 1;
	const wasm = (env.backends.onnx as { wasm?: { numThreads?: number } } | undefined)?.wasm;
	if (wasm) wasm.numThreads = wanted;
	return wanted;
}

function load(mode?: string) {
	loading ??= (async () => {
		const { device, dtype } = await resolveMode(mode);
		const threads = configureThreads();

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
