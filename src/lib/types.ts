/** A single RSS/Atom source. */
export type Feed = {
	id: string;
	name: string;
	url: string;
	/** Section ids this feed feeds into. A feed can serve more than one section. */
	sections: string[];
	enabled: boolean;
};

/**
 * A named chunk of the podcast. This is the customisation surface — the user
 * decides what sections exist, what each one is told to do, and which feeds
 * flow into it.
 */
export type Section = {
	id: string;
	title: string;
	/** Editorial instruction handed to the LLM for this section only. */
	prompt: string;
	/** Rough share of the podcast this section should occupy. */
	minutes: number;
	enabled: boolean;
};

export type Config = {
	version: number;
	/** Shown to the LLM so it can address the listener and skip things they know. */
	about: string;
	timezone: string;
	/** Only consider items published within this many hours. Fixes the "half of
	 *  this was in yesterday's brief" problem together with the seen-set. */
	windowHours: number;
	feeds: Feed[];
	sections: Section[];
	tts: {
		engine: 'melotts' | 'aura' | 'kokoro' | 'openrouter' | 'gemini';
		/** MeloTTS language code. */
		lang: string;
		/** Kokoro voice id, used only when engine === 'kokoro'. */
		kokoroVoice: string;
		/** Backend + precision as one choice, because the two must agree.
		 *  Empty means pick automatically. */
		kokoroMode: '' | 'webgpu-fp32' | 'webgpu-q4f16' | 'wasm-q8' | 'wasm-fp32';
		/** Deepgram Aura speaker, used only when engine === 'aura'. */
		auraSpeaker: string;
		/** OpenRouter TTS model id, e.g. 'deepgram/flux-tts:free'. */
		openrouterModel: string;
		/** Voice for that model — a Flux voice id, a fish.audio voice id, or a Kokoro voice. */
		openrouterVoice: string;
		/** Gemini TTS prebuilt voice name, e.g. 'Kore'. */
		geminiVoice: string;
		/** Playback rate baked into nothing — just remembered for the player. */
		rate: number;
	};
	schedule: {
		enabled: boolean;
		/** UTC hour (0-23) the cron should build this user's brief. */
		hourUTC: number;
	};
};

/** A normalised item pulled out of a feed. */
export type Item = {
	/** Stable hash of title+link, used for cross-day dedupe. */
	hash: string;
	feedId: string;
	feedName: string;
	title: string;
	link: string;
	summary: string;
	published: string | null;
};

/** One spoken chunk. Segments map 1:1 to TTS requests on the client. */
export type Segment = {
	id: string;
	/** Section this belongs to, or 'intro' / 'outro'. */
	sectionId: string;
	title: string;
	text: string;
	sources: { title: string; url: string }[];
};

export type Brief = {
	id: string;
	createdAt: string;
	/** Local date string the brief was built for. */
	date: string;
	segments: Segment[];
	stats: {
		itemsConsidered: number;
		itemsUsed: number;
		itemsSkippedAsSeen: number;
		chars: number;
		estimatedMinutes: number;
		feedErrors: { feedId: string; name: string; error: string }[];
	};
};

/** Result of fetching one feed, returned by POST /api/feed. */
export type FeedResult = {
	feedId: string;
	name: string;
	items: Item[];
	error?: string;
};
