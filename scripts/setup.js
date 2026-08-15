#!/usr/bin/env node
/**
 * One-shot provisioning for a fresh Cloudflare account.
 *
 * Creates the KV namespace, writes its id into both wrangler configs, sets the
 * secrets, deploys both Workers, then wires the deployed URL back into the
 * config so the scheduler can call the app.
 *
 * Idempotent: re-running reuses the existing namespace and just redeploys.
 *
 * Fully non-interactive when GROQ_API_KEY is set (and CLOUDFLARE_ACCOUNT_ID too,
 * if your login has more than one account), so an agent can run it unattended.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const APP_CONFIG = 'wrangler.jsonc';
const CRON_CONFIG = 'cron/wrangler.jsonc';

const c = {
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
	green: (s) => `\x1b[32m${s}\x1b[0m`,
	red: (s) => `\x1b[31m${s}\x1b[0m`,
	yellow: (s) => `\x1b[33m${s}\x1b[0m`
};

let step = 0;
const say = (msg) => console.log(`\n${c.bold(`[${++step}]`)} ${msg}`);
const note = (msg) => console.log(`    ${c.dim(msg)}`);

function wrangler(args, { input, quiet } = {}) {
	try {
		return execFileSync('npx', ['wrangler', ...args], {
			encoding: 'utf8',
			input,
			stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe']
		});
	} catch (e) {
		const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
		if (!quiet) {
			console.error(c.red(`\nwrangler ${args.join(' ')} failed:\n`));
			console.error(out || e.message);
		}
		const err = new Error(`wrangler ${args[0]} failed`);
		err.output = out;
		throw err;
	}
}

function read(path) {
	return readFileSync(path, 'utf8');
}

/** These configs are ours, so targeted string edits beat a JSONC parser. */
export function setJsoncValue(path, key, value) {
	const src = read(path);
	const pattern = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
	if (!pattern.test(src)) throw new Error(`${path}: no "${key}" field to update`);
	writeFileSync(path, src.replace(pattern, `$1"${value}"`));
}

export function ensureAccountId(path, accountId) {
	const src = read(path);
	if (/"account_id"\s*:/.test(src)) {
		writeFileSync(path, src.replace(/("account_id"\s*:\s*)"[^"]*"/, `$1"${accountId}"`));
		return;
	}
	writeFileSync(
		path,
		src.replace(/("name"\s*:\s*"[^"]*",)/, `$1\n\t"account_id": "${accountId}",`)
	);
}

async function ask(question, { secret = false } = {}) {
	if (!process.stdin.isTTY) return '';
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	if (secret) {
		// Best-effort masking; wrangler itself echoes nothing either way.
		process.stdout.write(question);
		rl.output.write = () => {};
	}
	const answer = await rl.question(secret ? '' : question);
	rl.close();
	if (secret) process.stdout.write('\n');
	return answer.trim();
}

async function main() {
	console.log(c.bold('\nTransitCast setup\n'));
	console.log(
		c.dim('Creates KV, sets secrets, deploys the app and the scheduler. Safe to re-run.')
	);

	// ── Account ────────────────────────────────────────────────────────────────
	say('Checking your Cloudflare login');
	let whoami;
	try {
		whoami = wrangler(['whoami'], { quiet: true });
	} catch (e) {
		console.error(c.red('\nNot logged in. Run `npx wrangler login` first.'));
		process.exit(1);
	}

	const accounts = [...whoami.matchAll(/│\s*([^│]+?)\s*│\s*([0-9a-f]{32})\s*│/g)].map((m) => ({
		name: m[1].trim(),
		id: m[2]
	}));

	let accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	if (!accountId && accounts.length === 1) accountId = accounts[0].id;
	if (!accountId && accounts.length > 1) {
		console.log(c.yellow('\n    Your login has several accounts:'));
		accounts.forEach((a, i) => console.log(`      ${i + 1}. ${a.name}  ${c.dim(a.id)}`));
		const pick = await ask('\n    Which one? (number) ');
		const chosen = accounts[Number(pick) - 1];
		if (!chosen) {
			console.error(
				c.red('\nNo account chosen. Re-run with CLOUDFLARE_ACCOUNT_ID=<id> to skip this prompt.')
			);
			process.exit(1);
		}
		accountId = chosen.id;
	}

	if (accountId) {
		ensureAccountId(APP_CONFIG, accountId);
		ensureAccountId(CRON_CONFIG, accountId);
		note(`account_id ${accountId} written to both configs`);
	}

	// ── KV ─────────────────────────────────────────────────────────────────────
	say('Creating the KV namespace');
	const title = 'transitcast-TC_KV';
	let kvId;

	const existing = wrangler(['kv', 'namespace', 'list'], { quiet: true });
	try {
		const parsed = JSON.parse(existing.slice(existing.indexOf('[')));
		kvId = parsed.find((n) => n.title === title || n.title?.endsWith('TC_KV'))?.id;
	} catch {
		/* fall through to create */
	}

	if (kvId) {
		note(`reusing existing namespace ${kvId}`);
	} else {
		const out = wrangler(['kv', 'namespace', 'create', 'TC_KV']);
		kvId = out.match(/[0-9a-f]{32}/)?.[0];
		if (!kvId) {
			console.error(c.red('\nCould not find the namespace id in wrangler output:\n'));
			console.error(out);
			process.exit(1);
		}
		note(`created ${kvId}`);
	}

	setJsoncValue(APP_CONFIG, 'id', kvId);
	setJsoncValue(CRON_CONFIG, 'id', kvId);

	// ── Secrets ────────────────────────────────────────────────────────────────
	say('Setting secrets');
	const llmKey =
		process.env.GROQ_API_KEY?.trim() ||
		process.env.LLM_API_KEY?.trim() ||
		(await ask('    Groq API key (console.groq.com/keys): ', { secret: true }));

	if (!llmKey) {
		console.error(
			c.red('\nNo API key given. Re-run with GROQ_API_KEY=<key> set, or paste one when asked.')
		);
		process.exit(1);
	}

	wrangler(['secret', 'put', 'LLM_API_KEY'], { input: `${llmKey}\n` });
	note('LLM_API_KEY set on the app');

	// Optional speech engines. Both are free (no card) but need a key; skipping
	// them just leaves those engines greyed out with a message saying which
	// secret to set. Env vars keep the unattended path unattended.
	const optionalKeys = [
		['OPENROUTER_API_KEY', 'OpenRouter API key for free cloud voices (openrouter.ai/keys), Enter to skip: '],
		['GEMINI_API_KEY', 'Gemini API key for Google TTS (aistudio.google.com/apikey), Enter to skip: ']
	];
	for (const [name, prompt] of optionalKeys) {
		const value = process.env[name]?.trim() || (await ask(`    ${prompt}`, { secret: true }));
		if (!value) continue;
		wrangler(['secret', 'put', name], { input: `${value}\n` });
		note(`${name} set on the app`);
	}

	const cronSecret = randomUUID();
	wrangler(['secret', 'put', 'CRON_SECRET'], { input: `${cronSecret}\n` });
	wrangler(['secret', 'put', 'CRON_SECRET', '-c', CRON_CONFIG], { input: `${cronSecret}\n` });
	note('CRON_SECRET generated and set on both Workers');

	// ── Deploy ─────────────────────────────────────────────────────────────────
	say('Building and deploying the app');
	execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
	const deployOut = wrangler(['deploy']);
	const appUrl = deployOut.match(/https:\/\/[^\s]*workers\.dev/)?.[0];

	if (!appUrl) {
		console.error(c.yellow('\nDeployed, but could not read the URL from wrangler output.'));
		console.error(c.yellow('Set PUBLIC_ORIGIN and APP_ORIGIN by hand, then re-run this script.'));
		process.exit(1);
	}
	note(`live at ${appUrl}`);

	say('Pointing the scheduler at it');
	setJsoncValue(APP_CONFIG, 'PUBLIC_ORIGIN', appUrl);
	setJsoncValue(CRON_CONFIG, 'APP_ORIGIN', appUrl);
	wrangler(['deploy']); // re-deploy so the app picks up PUBLIC_ORIGIN
	wrangler(['deploy', '-c', CRON_CONFIG]);
	note('scheduler deployed, runs hourly');

	console.log(c.green(`\n✓ Done — open ${appUrl}\n`));
	console.log('  Next: open Settings, describe yourself in the first box, pick your sections,');
	console.log('  then hit "Build today\'s brief" on the Listen tab.\n');
	console.log(
		c.dim(
			'  The KV id and account id are now in wrangler.jsonc and cron/wrangler.jsonc.\n' +
				'  Commit them if you like — neither is a secret.\n'
		)
	);
}

// Guarded so the file-editing helpers above can be imported and tested without
// provisioning anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error(c.red(`\nSetup failed: ${e.message}`));
		process.exit(1);
	});
}
