<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { BUILD, commitUrl } from '$lib/build';

	let { children } = $props();

	const built = BUILD.builtAt
		? new Date(BUILD.builtAt).toLocaleString(undefined, {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			})
		: '';

	const tabs = [
		{ href: '/', label: 'Listen' },
		{ href: '/settings', label: 'Settings' }
	];
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="theme-color" content="#0e1116" />
	<title>TransitCast</title>
</svelte:head>

<header>
	<div class="inner">
		<span class="brand">TransitCast</span>
		<nav>
			{#each tabs as tab (tab.href)}
				<a href={tab.href} class:active={page.url.pathname === tab.href}>{tab.label}</a>
			{/each}
		</nav>
	</div>
</header>

{@render children()}

<footer>
	<!-- Which commit is actually live. Cheap to add, and it settles the
	     "is my fix deployed yet?" question that costs real time otherwise. -->
	{#if commitUrl()}
		<a href={commitUrl()} target="_blank" rel="noreferrer noopener">{BUILD.commit}</a>
	{:else}
		<span>{BUILD.commit}</span>
	{/if}
	{#if built}<span>· built {built}</span>{/if}
</footer>

<style>
	footer {
		max-width: 720px;
		margin: 0 auto;
		padding: 1.5rem 1rem 6rem;
		display: flex;
		gap: 0.4rem;
		justify-content: center;
		font-size: 0.72rem;
		color: color-mix(in srgb, var(--muted) 65%, transparent);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	footer a {
		color: inherit;
		text-decoration: none;
		border-bottom: 1px dotted currentColor;
	}

	footer a:hover {
		color: var(--accent);
	}

	header {
		position: sticky;
		top: 0;
		z-index: 20;
		background: color-mix(in srgb, var(--bg) 88%, transparent);
		backdrop-filter: blur(12px);
		border-bottom: 1px solid var(--border);
	}

	.inner {
		max-width: 720px;
		margin: 0 auto;
		padding: 0.7rem 1rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.brand {
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	nav {
		display: flex;
		gap: 0.25rem;
	}

	nav a {
		color: var(--muted);
		text-decoration: none;
		padding: 0.35rem 0.7rem;
		border-radius: 999px;
		font-size: 0.9rem;
		font-weight: 550;
	}

	nav a.active {
		color: var(--text);
		background: var(--surface-2);
	}
</style>
