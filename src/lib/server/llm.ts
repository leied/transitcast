type Env = App.Platform['env'];

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export class LLMError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly retryAfter?: number
	) {
		super(message);
	}
}

/**
 * Minimal OpenAI-compatible chat call. Everything provider-specific lives in
 * two env vars (LLM_BASE_URL, LLM_MODEL) plus the key, so moving off Groq to
 * hackai, Cerebras or OpenRouter is a config change and nothing else.
 */
export async function chat(
	env: Env,
	messages: ChatMessage[],
	opts: { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal } = {}
): Promise<string> {
	const res = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
		method: 'POST',
		signal: opts.signal,
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${env.LLM_API_KEY}`
		},
		body: JSON.stringify({
			model: env.LLM_MODEL,
			messages,
			max_tokens: opts.maxTokens ?? 1200,
			temperature: opts.temperature ?? 0.4,
			...(opts.json ? { response_format: { type: 'json_object' } } : {})
		})
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		const retryAfter = Number(res.headers.get('retry-after')) || undefined;
		throw new LLMError(
			`LLM ${res.status}: ${body.slice(0, 300)}`,
			res.status,
			retryAfter
		);
	}

	const data = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	const content = data.choices?.[0]?.message?.content;
	if (!content) throw new LLMError('LLM returned no content', 502);
	return content;
}

/**
 * Models on the cheap tiers will occasionally wrap JSON in prose or a fence
 * even when asked not to. Recover instead of failing the whole brief.
 */
export function parseJsonLoose<T>(raw: string): T {
	const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		const start = trimmed.search(/[{[]/);
		const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
		if (start !== -1 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1)) as T;
		}
		throw new LLMError('LLM did not return usable JSON', 502);
	}
}
