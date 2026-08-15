<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Brief, Config } from '$lib/types';
	import { api } from '$lib/client/api';
	import { authHeaders } from '$lib/client/uid';
	import { audioStore, briefStore, pruneTo } from '$lib/client/db';
	import { renderBrief, type RenderProgress } from '$lib/client/tts';
	import { generateBrief, type Progress } from '$lib/pipeline';

	let config = $state<Config | null>(null);
	let brief = $state<Brief | null>(null);
	let audioUrl = $state<string | null>(null);
	let audioBlob = $state<Blob | null>(null);

	let busy = $state<'' | 'writing' | 'speaking'>('');
	let status = $state('');
	let error = $state('');
	let progress = $state(0);
	let skippedChunks = $state(0);
	let skippedReason = $state('');

	let player = $state<HTMLAudioElement | null>(null);
	let playing = $state(false);
	let currentTime = $state(0);
	let duration = $state(0);
	let rate = $state(1);

	let controller: AbortController | null = null;

	const hasAudio = $derived(!!audioUrl);
	const sections = $derived(
		brief ? [...new Set(brief.segments.map((s) => s.sectionId))] : []
	);

	onMount(async () => {
		try {
			config = await api.getConfig();
			rate = config.tts.rate || 1;
			const remote = await api.getBrief();
			if (remote) {
				brief = remote;
				await briefStore.put(remote);
				await loadAudio(remote.id);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});

	onDestroy(() => {
		controller?.abort();
		if (audioUrl) URL.revokeObjectURL(audioUrl);
	});

	async function loadAudio(id: string) {
		const stored = await audioStore.get(id);
		if (audioUrl) URL.revokeObjectURL(audioUrl);
		if (stored) {
			audioBlob = stored.blob;
			audioUrl = URL.createObjectURL(stored.blob);
		} else {
			audioBlob = null;
			audioUrl = null;
		}
	}

	async function build() {
		if (!config || busy) return;
		error = '';
		busy = 'writing';
		progress = 0;
		controller = new AbortController();

		try {
			const onProgress = (p: Progress) => {
				if (p.phase === 'feeds') {
					status = `Reading ${p.label} (${p.done}/${p.total})`;
					progress = (p.done / p.total) * 0.45;
				} else if (p.phase === 'writing') {
					status = `Writing ${p.label} (${p.done}/${p.total})`;
					progress = 0.45 + (p.done / p.total) * 0.55;
				}
			};

			const { brief: built, airedHashes } = await generateBrief(config, {
				headers: authHeaders(),
				onProgress,
				signal: controller.signal
			});

			await api.saveBrief(built, airedHashes);
			await briefStore.put(built);
			brief = built;
			await loadAudio(built.id);
			await speak();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = '';
			status = '';
			progress = 0;
			controller = null;
		}
	}

	async function speak() {
		if (!config || !brief) return;
		error = '';
		busy = 'speaking';
		progress = 0;
		controller ??= new AbortController();

		try {
			const onProgress = (p: RenderProgress) => {
				status = p.loading ?? `Speaking (${p.done}/${p.total})`;
				progress = p.total ? p.done / p.total : 0;
			};

			const { blob, skipped, reason } = await renderBrief(brief, config, {
				onProgress,
				signal: controller.signal
			});

			skippedChunks = skipped;
			skippedReason = reason ?? '';

			await audioStore.put({
				id: brief.id,
				blob,
				engine: config.tts.engine,
				createdAt: new Date().toISOString(),
				chars: brief.stats.chars
			});
			await pruneTo(5);
			await loadAudio(brief.id);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = '';
			status = '';
			progress = 0;
			controller = null;
		}
	}

	function cancel() {
		controller?.abort();
	}

	function toggle() {
		if (!player) return;
		if (player.paused) player.play();
		else player.pause();
	}

	function nudge(seconds: number) {
		if (!player) return;
		player.currentTime = Math.max(0, Math.min(player.duration || 0, player.currentTime + seconds));
	}

	function cycleRate() {
		const steps = [1, 1.25, 1.5, 1.75, 2];
		rate = steps[(steps.indexOf(rate) + 1) % steps.length];
		if (player) player.playbackRate = rate;
	}

	/** Lockscreen controls — the whole point is not having to look at the phone. */
	function wireMediaSession() {
		if (!('mediaSession' in navigator) || !brief) return;
		navigator.mediaSession.metadata = new MediaMetadata({
			title: `Brief for ${brief.date}`,
			artist: 'TransitCast',
			album: sections.length ? `${brief.stats.estimatedMinutes} min` : 'TransitCast'
		});
		navigator.mediaSession.setActionHandler('play', () => player?.play());
		navigator.mediaSession.setActionHandler('pause', () => player?.pause());
		navigator.mediaSession.setActionHandler('seekbackward', () => nudge(-15));
		navigator.mediaSession.setActionHandler('seekforward', () => nudge(30));
	}

	function download() {
		if (!audioBlob || !brief) return;
		const a = document.createElement('a');
		a.href = URL.createObjectURL(audioBlob);
		a.download = `transitcast-${brief.date}.${audioBlob.type.includes('wav') ? 'wav' : 'mp3'}`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function clock(seconds: number) {
		if (!Number.isFinite(seconds)) return '0:00';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function sectionTitle(id: string) {
		return config?.sections.find((s) => s.id === id)?.title ?? id;
	}
</script>

<div class="wrap">
	{#if error}
		<div class="card error">
			<strong>{error}</strong>
			<button class="ghost small" onclick={() => (error = '')}>Dismiss</button>
		</div>
	{/if}

	{#if busy}
		<div class="card">
			<div class="row" style="justify-content: space-between">
				<span>{status || 'Working…'}</span>
				<button class="ghost small" onclick={cancel}>Cancel</button>
			</div>
			<div class="bar"><div class="fill" style:width="{Math.round(progress * 100)}%"></div></div>
			{#if busy === 'speaking' && config?.tts.engine === 'kokoro'}
				<p class="tiny muted" style="margin: 0.5rem 0 0">
					First run downloads about 92MB of voice model. It's cached after that.
				</p>
			{/if}
		</div>
	{:else if !brief}
		<div class="card empty">
			<h1>No brief yet</h1>
			<p class="muted">
				Pull your feeds, write a script, and turn it into something you can listen to with the
				screen off.
			</p>
			<button class="primary" onclick={build} disabled={!config}>Build today's brief</button>
		</div>
	{:else}
		<div class="card head">
			<div>
				<h1>{brief.date}</h1>
				<p class="muted small" style="margin: 0.15rem 0 0">
					{brief.stats.estimatedMinutes} min · {brief.segments.length} segments · {brief.stats
						.itemsConsidered} items read
					{#if brief.stats.itemsSkippedAsSeen > 0}
						· {brief.stats.itemsSkippedAsSeen} already aired
					{/if}
				</p>
			</div>
			<div class="row">
				{#if !hasAudio}
					<button class="primary" onclick={speak}>Render audio</button>
				{/if}
				<button class="ghost" onclick={build}>Rebuild</button>
			</div>
		</div>

		{#if brief.stats.feedErrors.length}
			<details class="card warn">
				<summary>{brief.stats.feedErrors.length} feed(s) didn't respond</summary>
				<ul class="tiny">
					{#each brief.stats.feedErrors as fe (fe.feedId)}
						<li><strong>{fe.name}</strong> — {fe.error}</li>
					{/each}
				</ul>
			</details>
		{/if}

		{#if skippedChunks > 0}
			<div class="card warn">
				<span class="small">
					{skippedChunks} passage{skippedChunks === 1 ? '' : 's'} couldn't be spoken and {skippedChunks ===
					1
						? 'was'
						: 'were'} left out. Switching the engine to Kokoro in Settings renders on your device
					instead.
				</span>
				{#if skippedReason}
					<pre class="tiny reason">{skippedReason}</pre>
				{/if}
			</div>
		{/if}

		{#if audioUrl}
			<audio
				bind:this={player}
				src={audioUrl}
				preload="metadata"
				onplay={() => {
					playing = true;
					wireMediaSession();
				}}
				onpause={() => (playing = false)}
				ontimeupdate={() => (currentTime = player?.currentTime ?? 0)}
				onloadedmetadata={() => {
					duration = player?.duration ?? 0;
					if (player) player.playbackRate = rate;
				}}
			></audio>
		{/if}

		<div class="transcript stack">
			{#each brief.segments as segment (segment.id)}
				<article class="card seg">
					<div class="row" style="justify-content: space-between; align-items: baseline">
						<h3>{segment.title}</h3>
						{#if segment.sectionId !== 'intro' && segment.sectionId !== 'outro'}
							<span class="chip">{sectionTitle(segment.sectionId)}</span>
						{/if}
					</div>
					<p>{segment.text}</p>
					{#if segment.sources.length}
						<div class="sources tiny">
							{#each segment.sources as source (source.url)}
								<a href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a>
							{/each}
						</div>
					{/if}
				</article>
			{/each}
		</div>
	{/if}
</div>

{#if audioUrl && brief}
	<div class="playbar">
		<div class="playbar-inner">
			<button class="round" onclick={() => nudge(-15)} aria-label="Back 15 seconds">−15</button>
			<button class="round big primary" onclick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
				{playing ? '❚❚' : '▶'}
			</button>
			<button class="round" onclick={() => nudge(30)} aria-label="Forward 30 seconds">+30</button>

			<div class="scrub">
				<input
					type="range"
					min="0"
					max={duration || 0}
					step="0.5"
					value={currentTime}
					aria-label="Seek"
					oninput={(e) => {
						if (player) player.currentTime = Number(e.currentTarget.value);
					}}
				/>
				<div class="times tiny muted">
					<span>{clock(currentTime)}</span>
					<span>{clock(duration)}</span>
				</div>
			</div>

			<button class="round" onclick={cycleRate} aria-label="Playback speed">{rate}×</button>
			<button class="round" onclick={download} aria-label="Download audio">↓</button>
		</div>
	</div>
{/if}

<style>
	.empty {
		text-align: center;
		display: grid;
		gap: 0.85rem;
		justify-items: center;
		padding: 2.5rem 1.25rem;
		margin-top: 2rem;
	}

	.empty p {
		max-width: 34ch;
		margin: 0;
	}

	.head {
		display: flex;
		gap: 1rem;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 0.85rem;
	}

	.head > div:first-child {
		min-width: 0;
		flex: 1 1 12rem;
	}

	.head h1 {
		font-size: clamp(1.5rem, 8vw, 2rem);
	}

	.seg {
		min-width: 0;
	}

	.error {
		border-color: #4a2a2e;
		background: #21161a;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		margin-bottom: 0.85rem;
	}

	.warn {
		border-color: #45361f;
		background: #1e1a12;
		margin-bottom: 0.85rem;
	}

	.warn summary {
		cursor: pointer;
		color: var(--warn);
		font-size: 0.9rem;
	}

	.warn ul {
		margin: 0.6rem 0 0;
		padding-left: 1.1rem;
		color: var(--muted);
	}

	.reason {
		margin: 0.6rem 0 0;
		padding: 0.5rem 0.6rem;
		background: var(--bg);
		border-radius: var(--radius-sm);
		color: var(--muted);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	.bar {
		height: 6px;
		background: var(--bg);
		border-radius: 999px;
		overflow: hidden;
		margin-top: 0.7rem;
	}

	.fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.25s ease;
	}

	.seg h3 {
		font-size: 1.02rem;
	}

	.seg p {
		margin: 0.5rem 0 0;
		color: #d3dced;
	}

	.sources {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.7rem;
		padding-top: 0.6rem;
		border-top: 1px solid var(--border);
		min-width: 0;
	}

	.sources a {
		color: var(--muted);
		text-decoration: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.1rem 0.55rem;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		/* A flex item won't shrink below its content width without this, so a long
		   headline pushed the whole page wider than the phone. */
		flex: 0 1 auto;
		min-width: 0;
	}

	.sources a:hover {
		color: var(--accent);
		border-color: var(--accent-dim);
	}

	.playbar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 30;
		background: color-mix(in srgb, var(--surface) 94%, transparent);
		backdrop-filter: blur(14px);
		border-top: 1px solid var(--border);
		padding-bottom: env(safe-area-inset-bottom);
	}

	.playbar-inner {
		max-width: 720px;
		margin: 0 auto;
		padding: 0.6rem 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.round {
		border-radius: 999px;
		min-width: 3rem;
		height: 3rem;
		padding: 0;
		font-size: 0.85rem;
		font-weight: 600;
		flex: 0 0 auto;
	}

	.round.big {
		min-width: 3.4rem;
		height: 3.4rem;
		font-size: 1rem;
	}

	.scrub {
		flex: 1 1 auto;
		min-width: 0;
		padding: 0 0.25rem;
	}

	.scrub input {
		width: 100%;
		accent-color: var(--accent);
	}

	.times {
		display: flex;
		justify-content: space-between;
		margin-top: -0.2rem;
	}

	@media (max-width: 480px) {
		.scrub {
			order: -1;
			flex-basis: 100%;
		}

		.playbar-inner {
			flex-wrap: wrap;
			justify-content: center;
		}
	}
</style>
