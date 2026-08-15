import type { KVNamespace, Ai } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Error {
			message: string;
			/** Seconds the client should wait before retrying, from the LLM's 429. */
			retryAfter?: number;
			/** Verbatim upstream error text, so failures stay diagnosable. */
			upstream?: string;
		}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				TC_KV: KVNamespace;
				AI: Ai;
				LLM_BASE_URL: string;
				LLM_MODEL: string;
				LLM_API_KEY: string;
				PUBLIC_ORIGIN: string;
				CRON_SECRET: string;
				/** Optional: enables the OpenRouter speech engine (openrouter.ai/keys). */
				OPENROUTER_API_KEY?: string;
				/** Optional: enables the Gemini TTS engine (aistudio.google.com/apikey). */
				GEMINI_API_KEY?: string;
				/** Which Gemini TTS model to call; defaults to gemini-2.5-flash-preview-tts. */
				GEMINI_TTS_MODEL?: string;
			};
			context: { waitUntil(promise: Promise<unknown>): void };
			caches: CacheStorage;
		}
	}

	/** Injected by Vite's `define` — see buildInfo() in vite.config.ts. */
	const __BUILD_COMMIT__: string;
	const __BUILD_COMMITTED_AT__: string;
	const __BUILD_AT__: string;
}

export {};
