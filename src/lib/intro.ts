import type { Config } from './types';

/**
 * The intro and outro are templated rather than generated. They're the same
 * shape every day, so spending LLM tokens (and free-tier rate limit) on them
 * would buy nothing but variance.
 */
export function buildIntro(cfg: Config, sectionTitles: string[], now = Date.now()): string {
	const date = new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone: cfg.timezone
	}).format(new Date(now));

	const hour = Number(
		new Intl.DateTimeFormat('en-US', {
			hour: 'numeric',
			hour12: false,
			timeZone: cfg.timezone
		}).format(new Date(now))
	);
	const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

	if (sectionTitles.length === 0) {
		return `${greeting}. It's ${date}, and there's nothing new worth reporting since your last brief.`;
	}

	const list =
		sectionTitles.length === 1
			? sectionTitles[0]
			: `${sectionTitles.slice(0, -1).join(', ')} and ${sectionTitles[sectionTitles.length - 1]}`;

	return `${greeting}. It's ${date}. Today: ${list}.`;
}

export function buildOutro(): string {
	return `That's your brief. Have a good ride.`;
}
