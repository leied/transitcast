#!/usr/bin/env node
/**
 * Is MeloTTS broken for everything, or just for our text?
 *
 * Workers AI returns 3043 "Internal server error" for this model often enough
 * that it's worth being able to tell an upstream outage apart from a bad input
 * in ten seconds. Sends progressively harder inputs to the deployed app and
 * reports which ones survive.
 *
 *   pnpm check:tts                       # uses PUBLIC_ORIGIN from wrangler.jsonc
 *   pnpm check:tts https://my.workers.dev
 */
import { readFileSync } from 'node:fs';

const CASES = [
	['trivial', 'Hello.'],
	['sentence', 'Good morning. It is Saturday, August fifteenth.'],
	['numbers', 'The index fell twelve percent to about three hundred million dollars.'],
	['punctuation', "It's a \"quoted\" phrase - with a dash, a semicolon; and an ellipsis..."],
	['typographic', 'It’s a “quoted” phrase — with an em dash and an ellipsis…'],
	['long-400', 'The quick brown fox jumps over the lazy dog. '.repeat(9).slice(0, 400)],
	['long-480', 'The quick brown fox jumps over the lazy dog. '.repeat(11).slice(0, 480)],
	['long-900', 'The quick brown fox jumps over the lazy dog. '.repeat(21).slice(0, 900)]
];

function originFromConfig() {
	try {
		const raw = readFileSync('wrangler.jsonc', 'utf8');
		return raw.match(/"PUBLIC_ORIGIN"\s*:\s*"([^"]+)"/)?.[1];
	} catch {
		return undefined;
	}
}

const origin = (process.argv[2] || originFromConfig() || '').replace(/\/$/, '');
if (!origin || origin.includes('transitcast.workers.dev')) {
	console.error(
		'Pass your deployed URL, or set PUBLIC_ORIGIN in wrangler.jsonc:\n  pnpm check:tts https://transitcast.<you>.workers.dev'
	);
	process.exit(1);
}

console.log(`\nTesting ${origin}/api/tts\n`);

let ok = 0;
let failed = 0;

for (const [name, text] of CASES) {
	const started = Date.now();
	let line;
	try {
		const res = await fetch(`${origin}/api/tts`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-tc-uid': 'ttsdiagnostic1' },
			body: JSON.stringify({ text, lang: 'en' })
		});
		const ms = Date.now() - started;

		if (res.ok) {
			const bytes = (await res.arrayBuffer()).byteLength;
			ok++;
			line = `\x1b[32mok  \x1b[0m ${name.padEnd(13)} ${String(text.length).padStart(4)} chars → ${String(bytes).padStart(7)} bytes  ${ms}ms`;
		} else {
			failed++;
			const detail = await res.json().catch(() => ({}));
			// The verbatim upstream text is the useful part — Workers AI error codes
			// are what distinguish "out of allowance" from "upstream had a moment".
			const raw = detail.upstream ?? detail.message ?? '';
			line = `\x1b[31mFAIL\x1b[0m ${name.padEnd(13)} ${String(text.length).padStart(4)} chars → ${res.status}  ${String(raw).slice(0, 120)}`;
		}
	} catch (e) {
		failed++;
		line = `\x1b[31mFAIL\x1b[0m ${name.padEnd(13)} ${e.message}`;
	}
	console.log(line);
}

console.log(`\n${ok} passed, ${failed} failed\n`);

if (failed === CASES.length) {
	console.log('Everything failed, including "Hello." — this is Workers AI being down for');
	console.log('this model, not our text. Switch the engine to Kokoro in Settings to keep');
	console.log('working; it renders on your device and needs nothing from Cloudflare.\n');
} else if (failed > 0) {
	console.log('Some inputs work and some do not, so the failing shapes above are the');
	console.log('trigger. Worth narrowing before blaming upstream.\n');
} else {
	console.log('MeloTTS is healthy right now. If a brief still fails, the trigger is in the');
	console.log('generated text — rerun this with the failing passage as an extra case.\n');
}
