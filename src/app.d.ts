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
			};
			context: { waitUntil(promise: Promise<unknown>): void };
			caches: CacheStorage;
		}
	}
}

export {};
