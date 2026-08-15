import type { Config, Feed, Section } from './types';

/**
 * Every URL in here was checked to return a parseable feed with items in it.
 * Feeds that 404'd, 403'd bots or failed DNS were dropped rather than shipped
 * broken — a dead feed in the default set looks exactly like the app being
 * flaky. Note the trailing slashes; chinadigitaltimes.net 403s without one.
 */
export const DEFAULT_SECTIONS: Section[] = [
	{
		id: 'world',
		title: 'World',
		prompt:
			'The big stories anyone should know about today. Lead with consequence, not drama. ' +
			'If several outlets carry the same story, merge them into one item and say so.',
		minutes: 4,
		enabled: true
	},
	{
		id: 'tech',
		title: 'Tech & Security',
		prompt:
			'Engineering-relevant news: breaches, outages, releases, platform changes. Skip funding ' +
			'rounds, launches with no product, and anything that reads like a press release.',
		minutes: 4,
		enabled: true
	},
	{
		id: 'ai',
		title: 'AI',
		prompt:
			'Model releases, capability results, policy, and incidents. The listener works with these ' +
			'tools daily, so skip explainers and assume the vocabulary.',
		minutes: 3,
		enabled: true
	},
	{
		id: 'seattle',
		title: 'Seattle & Transit',
		prompt:
			'Local Seattle news, with weight on transit: service changes, delays, route and schedule ' +
			'decisions, fares, construction. The listener rides the bus a few hours a day, so anything ' +
			'affecting a commute leads.',
		minutes: 2,
		enabled: true
	},
	{
		id: 'markets',
		title: 'Markets',
		prompt: 'Only move-the-needle market news. One or two items, or skip the section entirely.',
		minutes: 1,
		enabled: false
	},
	{
		id: 'ideas',
		title: 'Ideas',
		prompt:
			'Longer-form argument and commentary worth chewing on. One piece, summarised as an ' +
			'argument with its strongest objection, not as a headline.',
		minutes: 2,
		enabled: true
	}
];

export const DEFAULT_FEEDS: Feed[] = [
	// World
	{ id: 'bbc-world', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', sections: ['world'], enabled: true },
	{ id: 'guardian-world', name: 'The Guardian — World', url: 'https://www.theguardian.com/world/rss', sections: ['world'], enabled: true },
	{ id: 'npr', name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', sections: ['world'], enabled: true },
	{ id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', sections: ['world'], enabled: true },

	// Tech & security
	{ id: 'thn', name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews', sections: ['tech'], enabled: true },
	{ id: 'techmeme', name: 'Techmeme', url: 'https://www.techmeme.com/feed.xml', sections: ['tech'], enabled: true },
	{ id: 'hn', name: 'Hacker News', url: 'https://news.ycombinator.com/rss', sections: ['tech'], enabled: true },
	{ id: 'arstechnica', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', sections: ['tech'], enabled: true },
	{ id: 'theregister', name: 'The Register', url: 'https://www.theregister.com/headlines.atom', sections: ['tech'], enabled: true },
	{ id: 'arch', name: 'Arch Linux', url: 'https://archlinux.org/feeds/news/', sections: ['tech'], enabled: true },
	{ id: 'tldr-tech', name: 'TLDR Tech', url: 'https://bullrich.dev/tldr-rss/tech.rss', sections: ['tech'], enabled: false },

	// AI
	{ id: 'transformer', name: 'Transformer News', url: 'https://www.transformernews.ai/feed', sections: ['ai'], enabled: true },
	{ id: 'simonwillison', name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', sections: ['ai'], enabled: true },
	{ id: 'tldr-ai', name: 'TLDR AI', url: 'https://bullrich.dev/tldr-rss/ai.rss', sections: ['ai'], enabled: false },
	{ id: 'claudestatus', name: 'Claude Status', url: 'https://status.claude.com/history.rss', sections: ['ai'], enabled: false },

	// Seattle & transit
	{ id: 'seattletimes', name: 'The Seattle Times', url: 'https://www.seattletimes.com/feed/', sections: ['seattle'], enabled: true },
	{ id: 'urbanist', name: 'The Urbanist', url: 'https://www.theurbanist.org/feed/', sections: ['seattle'], enabled: true },
	{ id: 'stb', name: 'Seattle Transit Blog', url: 'https://seattletransitblog.com/feed/', sections: ['seattle'], enabled: true },

	// Markets
	{ id: 'marketwatch', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', sections: ['markets'], enabled: true },

	// Ideas
	{ id: 'haidt', name: 'After Babel (Haidt)', url: 'https://www.afterbabel.com/feed', sections: ['ideas'], enabled: true },
	{ id: 'lunduke', name: 'Lunduke', url: 'https://lunduke.substack.com/feed', sections: ['ideas'], enabled: true }
];

export function defaultConfig(): Config {
	return {
		version: 1,
		about:
			'I ride public transit a few hours a day and listen to this instead of looking at a screen. ' +
			'I write software, follow AI closely, and care about censorship and civil liberties.',
		timezone: 'America/Los_Angeles',
		windowHours: 24,
		feeds: structuredClone(DEFAULT_FEEDS),
		sections: structuredClone(DEFAULT_SECTIONS),
		tts: {
			// Aura rather than MeloTTS: MeloTTS returns error 3043 persistently
			// (reports since July, an incident on 13 Aug, and every chunk failing on
			// a live deployment on 15 Aug). Aura is a different upstream, sounds
			// better, and needs no download — it just costs more of the daily
			// neuron allowance, which the Settings meter shows.
			engine: 'aura',
			lang: 'en',
			kokoroVoice: 'af_heart',
			kokoroDtype: '',
			auraSpeaker: 'asteria',
			rate: 1
		},
		schedule: { enabled: false, hourUTC: 13 }
	};
}
