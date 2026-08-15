import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';

/**
 * Stamp the build with the commit it came from. Half of debugging a deployed
 * Worker is working out whether the fix is even live yet.
 */
function buildInfo() {
	const git = (args: string[]) =>
		execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

	let commit = '';
	let dirty = false;
	let committedAt = '';

	try {
		commit = git(['rev-parse', '--short=8', 'HEAD']);
		dirty = git(['status', '--porcelain']).length > 0;
		committedAt = git(['log', '-1', '--format=%cI']);
	} catch {
		// No git in the build environment (Cloudflare Workers Builds, a tarball
		// deploy) — fall back to whatever CI exposes.
		commit = (
			process.env.WORKERS_CI_COMMIT_SHA ??
			process.env.CF_PAGES_COMMIT_SHA ??
			process.env.GITHUB_SHA ??
			'unknown'
		).slice(0, 8);
	}

	return {
		commit: dirty ? `${commit}+dirty` : commit,
		committedAt,
		builtAt: new Date().toISOString()
	};
}

const info = buildInfo();

export default defineConfig({
	define: {
		__BUILD_COMMIT__: JSON.stringify(info.commit),
		__BUILD_COMMITTED_AT__: JSON.stringify(info.committedAt),
		__BUILD_AT__: JSON.stringify(info.builtAt)
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter()
		})
	]
});
