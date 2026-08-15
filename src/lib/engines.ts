/**
 * Facts about the cloud speech engines that both the client and the server
 * need to agree on: how big a chunk each one gets, how many free requests a
 * day there are, and which voices exist. Kept out of the route so the Settings
 * page can show honest budget arithmetic without a round trip.
 */

/**
 * Chunk size per engine, in characters. Free cloud engines are capped by
 * requests per day, not by characters, so bigger chunks mean more briefs a day:
 * a 9,000-character brief is 6 OpenRouter requests at 1,500 or 3 Gemini
 * requests at 3,000. The ceilings are the upstreams' own — Deepgram (behind
 * OpenRouter's Flux) takes 2,000 characters per request, and Google says
 * Gemini TTS drifts on outputs "longer than a few minutes", so ~3 minutes it is.
 */
export const CHUNK_CHARS = {
	openrouter: 1500,
	gemini: 3000
} as const;

/** OpenRouter's platform cap on `:free` model variants (RPM 20). 1,000/day if the account has ever bought $10 of credit. */
export const OPENROUTER_FREE_RPD = 50;
export const OPENROUTER_FREE_RPM = 20;
/** Google AI Studio free tier for gemini-2.5-flash-preview-tts, as documented in 2026: 3 RPM, 15 RPD, 10k TPM. */
export const GEMINI_FREE_RPD = 15;
export const GEMINI_FREE_RPM = 3;

export type OpenRouterModel = {
	id: string;
	name: string;
	/** USD per character; 0 for the free variants. */
	perChar: number;
	/** How the voice field is interpreted. */
	voices: 'flux' | 'fish' | 'kokoro';
	defaultVoice: string;
	note: string;
};

/**
 * From OpenRouter's `/api/v1/models?output_modalities=speech` on 2026-08-15.
 * The two `:free` variants cost nothing; Kokoro is listed because at $0.62 per
 * million characters a brief is half a cent, and it's the same voices as the
 * on-device engine without the phone doing the work.
 */
export const OPENROUTER_MODELS: OpenRouterModel[] = [
	{
		id: 'deepgram/flux-tts:free',
		name: 'Deepgram Flux TTS (free)',
		perChar: 0,
		voices: 'flux',
		defaultVoice: 'flux-brooke-en',
		note: 'English, 36 voices. Free: 20 requests/min, 50/day per OpenRouter account.'
	},
	{
		id: 'fish-audio/s2.1-pro-free:free',
		name: 'Fish Audio S2.1 Pro (free)',
		perChar: 0,
		voices: 'fish',
		defaultVoice: 'b347db033a6549378b48d00acb0d06cd',
		note: 'Multilingual, expressive. Free variant has no latency or availability guarantees. Voice is a fish.audio voice id.'
	},
	{
		id: 'hexgrad/kokoro-82m',
		name: 'Kokoro 82M in the cloud (paid, ~½¢ per brief)',
		perChar: 0.00000062,
		voices: 'kokoro',
		defaultVoice: 'af_heart',
		note: 'Same voices as the on-device engine, rendered by DeepInfra. Needs OpenRouter credit.'
	}
];

export function openrouterModel(id: string): OpenRouterModel | undefined {
	return OPENROUTER_MODELS.find((m) => m.id === id);
}

/** Deepgram Flux voice ids exposed by OpenRouter (36, all English). */
export const FLUX_VOICES = [
	'flux-alexis-en',
	'flux-bree-en',
	'flux-brittany-en',
	'flux-brooke-en',
	'flux-bruce-en',
	'flux-cliff-en',
	'flux-cole-en',
	'flux-colin-en',
	'flux-conor-en',
	'flux-donovan-en',
	'flux-drew-en',
	'flux-elise-en',
	'flux-gemma-en',
	'flux-haley-en',
	'flux-hannah-en',
	'flux-heather-en',
	'flux-jack-en',
	'flux-kai-en',
	'flux-kelsey-en',
	'flux-kit-en',
	'flux-maeve-en',
	'flux-marcelo-en',
	'flux-marcus-en',
	'flux-meena-en',
	'flux-meghan-en',
	'flux-miles-en',
	'flux-naveen-en',
	'flux-paige-en',
	'flux-priya-en',
	'flux-rufus-en',
	'flux-sean-en',
	'flux-sharon-en',
	'flux-sienna-en',
	'flux-tanner-en',
	'flux-wade-en',
	'flux-wes-en'
];

export function fluxVoiceLabel(id: string): string {
	const name = id.replace(/^flux-/, '').replace(/-en$/, '');
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Gemini TTS prebuilt voices with Google's one-word descriptions. */
export const GEMINI_VOICES: { id: string; tone: string }[] = [
	{ id: 'Zephyr', tone: 'Bright' },
	{ id: 'Puck', tone: 'Upbeat' },
	{ id: 'Charon', tone: 'Informative' },
	{ id: 'Kore', tone: 'Firm' },
	{ id: 'Fenrir', tone: 'Excitable' },
	{ id: 'Leda', tone: 'Youthful' },
	{ id: 'Orus', tone: 'Firm' },
	{ id: 'Aoede', tone: 'Breezy' },
	{ id: 'Callirrhoe', tone: 'Easy-going' },
	{ id: 'Autonoe', tone: 'Bright' },
	{ id: 'Enceladus', tone: 'Breathy' },
	{ id: 'Iapetus', tone: 'Clear' },
	{ id: 'Umbriel', tone: 'Easy-going' },
	{ id: 'Algieba', tone: 'Smooth' },
	{ id: 'Despina', tone: 'Smooth' },
	{ id: 'Erinome', tone: 'Clear' },
	{ id: 'Algenib', tone: 'Gravelly' },
	{ id: 'Rasalgethi', tone: 'Informative' },
	{ id: 'Laomedeia', tone: 'Upbeat' },
	{ id: 'Achernar', tone: 'Soft' },
	{ id: 'Alnilam', tone: 'Firm' },
	{ id: 'Schedar', tone: 'Even' },
	{ id: 'Gacrux', tone: 'Mature' },
	{ id: 'Pulcherrima', tone: 'Forward' },
	{ id: 'Achird', tone: 'Friendly' },
	{ id: 'Zubenelgenubi', tone: 'Casual' },
	{ id: 'Vindemiatrix', tone: 'Gentle' },
	{ id: 'Sadachbia', tone: 'Lively' },
	{ id: 'Sadaltager', tone: 'Knowledgeable' },
	{ id: 'Sulafat', tone: 'Warm' }
];
