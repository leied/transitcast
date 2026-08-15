/**
 * Build stamp, substituted by Vite's `define` at compile time. Exposed both in
 * the UI footer and at /api/version so "is my fix deployed?" is answerable
 * without guessing from behaviour.
 */
export const BUILD = {
	commit: __BUILD_COMMIT__,
	committedAt: __BUILD_COMMITTED_AT__,
	builtAt: __BUILD_AT__,
	repo: 'https://github.com/leied/transitcast'
};

export function commitUrl(commit = BUILD.commit): string | null {
	const clean = commit.replace('+dirty', '');
	if (!clean || clean === 'unknown') return null;
	return `${BUILD.repo}/commit/${clean}`;
}
