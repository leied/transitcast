<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';

	let { children } = $props();

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

<style>
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
