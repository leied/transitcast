<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Config, Feed, Section } from '$lib/types';
	import { api } from '$lib/client/api';
	import { getUid } from '$lib/client/uid';
	import { defaultConfig } from '$lib/defaults';
	import { CHARS_PER_MINUTE } from '$lib/chunk';
	import {
		VOICE_GROUPS,
		voicesIn,
		voiceLabel,
		previewVoice,
		kokoroStatus,
		SAMPLE_TEXT
	} from '$lib/client/kokoro';
	import { previewServerVoice, engineLabel } from '$lib/client/tts';
	import {
		CHUNK_CHARS,
		OPENROUTER_MODELS,
		OPENROUTER_FREE_RPD,
		GEMINI_FREE_RPD,
		GEMINI_FREE_RPM,
		FLUX_VOICES,
		fluxVoiceLabel,
		GEMINI_VOICES,
		openrouterModel
	} from '$lib/engines';

	const AURA_SPEAKERS = [
		{ id: 'asteria', name: 'Asteria', gender: 'F' },
		{ id: 'luna', name: 'Luna', gender: 'F' },
		{ id: 'stella', name: 'Stella', gender: 'F' },
		{ id: 'athena', name: 'Athena', gender: 'F' },
		{ id: 'hera', name: 'Hera', gender: 'F' },
		{ id: 'orion', name: 'Orion', gender: 'M' },
		{ id: 'arcas', name: 'Arcas', gender: 'M' },
		{ id: 'perseus', name: 'Perseus', gender: 'M' },
		{ id: 'angus', name: 'Angus', gender: 'M' },
		{ id: 'orpheus', name: 'Orpheus', gender: 'M' },
		{ id: 'helios', name: 'Helios', gender: 'M' },
		{ id: 'zeus', name: 'Zeus', gender: 'M' }
	];

	let config = $state<Config | null>(null);
	let dirty = $state(false);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);
	let uid = $state('');

	let newFeed = $state({ name: '', url: '', sections: [] as string[] });
	let testing = $state<Record<string, string>>({});

	let previewing = $state('');
	let previewUrl = $state('');
	let previewError = $state('');
	let backend = $state<{ device: string; dtype: string } | null>(null);

	/** Auditioning a voice beats guessing from a name and a letter grade. */
	async function preview() {
		if (!config || previewing) return;
		const voice = config.tts.kokoroVoice;
		previewing = voice;
		previewError = '';
		try {
			const blob = await previewVoice(voice, config.tts.kokoroMode || undefined);
			if (previewUrl) URL.revokeObjectURL(previewUrl);
			previewUrl = URL.createObjectURL(blob);
			// Autoplay is allowed here: the click that started this counts as the gesture.
			queueMicrotask(() => document.querySelector<HTMLAudioElement>('audio')?.play());
		} catch (e) {
			previewError = e instanceof Error ? e.message : String(e);
		} finally {
			previewing = '';
			// Surface which backend actually ran; it's the difference between
			// speech and noise, and it isn't otherwise visible.
			backend = kokoroStatus();
		}
	}

	/**
	 * Same idea for the server engines: one short request against whatever the
	 * engine's allowance is, so a voice can be judged before spending a brief on it.
	 */
	let serverPreviewing = $state(false);
	let serverPreviewUrl = $state('');
	let serverPreviewError = $state('');
	async function previewServer() {
		if (!config || serverPreviewing) return;
		serverPreviewing = true;
		serverPreviewError = '';
		try {
			const blob = await previewServerVoice(config, SAMPLE_TEXT);
			if (serverPreviewUrl) URL.revokeObjectURL(serverPreviewUrl);
			serverPreviewUrl = URL.createObjectURL(blob);
			queueMicrotask(() =>
				document.querySelector<HTMLAudioElement>('audio.server-preview')?.play()
			);
		} catch (e) {
			serverPreviewError = e instanceof Error ? e.message : String(e);
		} finally {
			serverPreviewing = false;
		}
	}

	/** The voice field means something different per OpenRouter model, so a model change resets it. */
	function onOpenrouterModelChange() {
		if (!config) return;
		const m = openrouterModel(config.tts.openrouterModel);
		if (m) config.tts.openrouterVoice = m.defaultVoice;
		touch();
	}
	const orModel = $derived(config ? openrouterModel(config.tts.openrouterModel) : undefined);

	onDestroy(() => {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		if (serverPreviewUrl) URL.revokeObjectURL(serverPreviewUrl);
	});

	onMount(async () => {
		uid = getUid();
		try {
			config = await api.getConfig();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});

	function touch() {
		dirty = true;
		saved = false;
	}

	async function save() {
		if (!config) return;
		saving = true;
		error = '';
		try {
			await api.putConfig(config);
			dirty = false;
			saved = true;
			setTimeout(() => (saved = false), 2500);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	// ── Budget estimate ────────────────────────────────────────────────────────
	// Workers AI gives 10,000 neurons/day free, and the engines differ by nearly
	// two orders of magnitude: MeloTTS bills 18.63 per audio minute while Aura
	// bills 1,363.64 per 1,000 characters. Aura is good enough to be worth it and
	// cheap enough for one brief a day, but not for four — so show the arithmetic
	// rather than let someone find out by hitting a wall.
	const FREE_NEURONS = 10_000;
	const totalMinutes = $derived(
		(config?.sections ?? []).filter((s) => s.enabled).reduce((n, s) => n + s.minutes, 0) + 0.3
	);
	const totalChars = $derived(Math.round(totalMinutes * CHARS_PER_MINUTE));
	const neurons = $derived(
		config?.tts.engine === 'kokoro'
			? 0
			: config?.tts.engine === 'aura'
				? Math.round((totalChars / 1000) * 1363.64)
				: Math.round(totalMinutes * 18.63)
	);
	const dailyShare = $derived(Math.min(100, Math.round((neurons / FREE_NEURONS) * 100)));
	const briefsPerDay = $derived(neurons > 0 ? Math.floor(FREE_NEURONS / neurons) : Infinity);

	// The key-based cloud engines are metered in requests, not neurons: a brief
	// costs ceil(chars / chunk) of them, so show that against the daily cap.
	const requestsPerBrief = $derived(
		config?.tts.engine === 'openrouter'
			? Math.ceil(totalChars / CHUNK_CHARS.openrouter)
			: config?.tts.engine === 'gemini'
				? Math.ceil(totalChars / CHUNK_CHARS.gemini)
				: 0
	);
	const requestCap = $derived(
		config?.tts.engine === 'openrouter'
			? OPENROUTER_FREE_RPD
			: config?.tts.engine === 'gemini'
				? GEMINI_FREE_RPD
				: 0
	);
	const requestShare = $derived(
		requestCap ? Math.min(100, Math.round((requestsPerBrief / requestCap) * 100)) : 0
	);
	const paidPerBrief = $derived(
		config?.tts.engine === 'openrouter' && orModel?.perChar ? totalChars * orModel.perChar : 0
	);

	// ── Schedule time zone juggling ────────────────────────────────────────────
	function tzOffsetHours(tz: string): number {
		try {
			const now = new Date();
			const local = Number(
				new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(
					now
				)
			);
			let diff = local - now.getUTCHours();
			if (diff > 12) diff -= 24;
			if (diff < -12) diff += 24;
			return diff;
		} catch {
			return 0;
		}
	}

	const localHour = $derived(
		config ? (config.schedule.hourUTC + tzOffsetHours(config.timezone) + 24) % 24 : 0
	);

	function setLocalHour(hour: number) {
		if (!config) return;
		config.schedule.hourUTC = (hour - tzOffsetHours(config.timezone) + 24) % 24;
		touch();
	}

	function hourLabel(h: number) {
		const suffix = h < 12 ? 'am' : 'pm';
		const twelve = h % 12 === 0 ? 12 : h % 12;
		return `${twelve}:00 ${suffix}`;
	}

	// ── Sections ───────────────────────────────────────────────────────────────
	function addSection() {
		if (!config) return;
		const id = `s${crypto.randomUUID().slice(0, 8)}`;
		config.sections = [
			...config.sections,
			{ id, title: 'New section', prompt: 'What should this section cover?', minutes: 2, enabled: true }
		];
		touch();
	}

	function removeSection(id: string) {
		if (!config) return;
		config.sections = config.sections.filter((s) => s.id !== id);
		for (const feed of config.feeds) feed.sections = feed.sections.filter((s) => s !== id);
		touch();
	}

	function moveSection(index: number, by: number) {
		if (!config) return;
		const next = index + by;
		if (next < 0 || next >= config.sections.length) return;
		const copy = [...config.sections];
		[copy[index], copy[next]] = [copy[next], copy[index]];
		config.sections = copy;
		touch();
	}

	// ── Feeds ──────────────────────────────────────────────────────────────────
	function toggleFeedSection(feed: Feed, sectionId: string) {
		feed.sections = feed.sections.includes(sectionId)
			? feed.sections.filter((s) => s !== sectionId)
			: [...feed.sections, sectionId];
		touch();
	}

	function removeFeed(id: string) {
		if (!config) return;
		config.feeds = config.feeds.filter((f) => f.id !== id);
		touch();
	}

	function addFeed() {
		if (!config || !newFeed.url.trim()) return;
		const id = `f${crypto.randomUUID().slice(0, 8)}`;
		config.feeds = [
			...config.feeds,
			{
				id,
				name: newFeed.name.trim() || new URL(newFeed.url).hostname.replace(/^www\./, ''),
				url: newFeed.url.trim(),
				sections: [...newFeed.sections],
				enabled: true
			}
		];
		newFeed = { name: '', url: '', sections: [] };
		touch();
	}

	async function testFeed(feed: Feed) {
		testing = { ...testing, [feed.id]: 'Checking…' };
		try {
			const result = await api.testFeed(feed.id, feed.url);
			testing = {
				...testing,
				[feed.id]: result.error
					? `Failed: ${result.error}`
					: `${result.items.length} item${result.items.length === 1 ? '' : 's'} in the last ${config?.windowHours}h`
			};
		} catch (e) {
			testing = { ...testing, [feed.id]: e instanceof Error ? e.message : 'Failed' };
		}
	}

	function resetAll() {
		if (!confirm('Reset every setting back to the defaults? Your feeds and sections go too.')) return;
		config = defaultConfig();
		touch();
	}

	function copyShareLink() {
		navigator.clipboard.writeText(`${location.origin}/?uid=${uid}`);
	}

	function feedsIn(sectionId: string) {
		return (config?.feeds ?? []).filter((f) => f.enabled && f.sections.includes(sectionId)).length;
	}
</script>

<div class="wrap">
	{#if error}
		<div class="card error"><strong>{error}</strong></div>
	{/if}

	{#if !config}
		<p class="muted">Loading…</p>
	{:else}
		<section class="stack">
			<h2>You</h2>
			<div class="card stack">
				<div>
					<label for="about">What the writer should know about you</label>
					<textarea
						id="about"
						bind:value={config.about}
						oninput={touch}
						placeholder="Who you are, what you already follow, what to skip."
					></textarea>
					<p class="tiny muted" style="margin: 0.35rem 0 0">
						This goes into every section prompt. Being specific here does more for quality than
						anything else on this page.
					</p>
				</div>

				<div class="grid-2">
					<div>
						<label for="tz">Time zone</label>
						<input id="tz" type="text" bind:value={config.timezone} oninput={touch} />
					</div>
					<div>
						<label for="window">Only include items from the last</label>
						<div class="row">
							<input
								id="window"
								type="number"
								min="1"
								max="168"
								bind:value={config.windowHours}
								oninput={touch}
							/>
							<span class="muted small">hours</span>
						</div>
					</div>
				</div>
			</div>
		</section>

		<section class="stack">
			<div class="row" style="justify-content: space-between">
				<h2>Sections</h2>
				<button class="small" onclick={addSection}>Add section</button>
			</div>
			<p class="muted small" style="margin: -0.35rem 0 0">
				Each section is written by its own pass, so the direction you give here is followed
				closely. Order is the running order.
			</p>

			{#each config.sections as section, i (section.id)}
				<div class="card stack" class:off={!section.enabled}>
					<div class="row" style="justify-content: space-between; gap: 0.5rem">
						<input
							type="text"
							bind:value={section.title}
							oninput={touch}
							style="font-weight: 600; max-width: 18rem"
							aria-label="Section title"
						/>
						<div class="row">
							<button class="ghost tiny" onclick={() => moveSection(i, -1)} disabled={i === 0}
								>↑</button
							>
							<button
								class="ghost tiny"
								onclick={() => moveSection(i, 1)}
								disabled={i === config.sections.length - 1}>↓</button
							>
							<button class="ghost tiny danger" onclick={() => removeSection(section.id)}>
								Delete
							</button>
						</div>
					</div>

					<textarea bind:value={section.prompt} oninput={touch} aria-label="Editorial direction"
					></textarea>

					<div class="row" style="flex-wrap: wrap; gap: 1rem">
						<label class="inline">
							<input type="checkbox" bind:checked={section.enabled} onchange={touch} />
							Include
						</label>
						<label class="inline">
							Target
							<input
								type="number"
								min="0.5"
								max="15"
								step="0.5"
								bind:value={section.minutes}
								oninput={touch}
								style="width: 5rem"
							/>
							min
						</label>
						<span class="chip">{feedsIn(section.id)} feeds</span>
					</div>
				</div>
			{/each}
		</section>

		<section class="stack">
			<h2>Feeds</h2>
			<p class="muted small" style="margin: -0.35rem 0 0">
				A feed can serve more than one section. Test before you rely on it — publishers change
				URLs and some block robots outright.
			</p>

			<div class="card stack">
				<div class="grid-2">
					<div>
						<label for="nf-url">Feed URL</label>
						<input
							id="nf-url"
							type="url"
							bind:value={newFeed.url}
							placeholder="https://example.com/feed"
						/>
					</div>
					<div>
						<label for="nf-name">Name (optional)</label>
						<input id="nf-name" type="text" bind:value={newFeed.name} placeholder="Auto from URL" />
					</div>
				</div>
				<div class="row" style="flex-wrap: wrap; gap: 0.4rem">
					{#each config.sections as section (section.id)}
						<button
							class="chip"
							class:on={newFeed.sections.includes(section.id)}
							onclick={() =>
								(newFeed.sections = newFeed.sections.includes(section.id)
									? newFeed.sections.filter((s) => s !== section.id)
									: [...newFeed.sections, section.id])}
						>
							{section.title}
						</button>
					{/each}
				</div>
				<div>
					<button class="primary" onclick={addFeed} disabled={!newFeed.url.trim()}>Add feed</button>
				</div>
			</div>

			{#each config.sections as section (section.id)}
				{@const feeds = config.feeds.filter((f) => f.sections.includes(section.id))}
				{#if feeds.length}
					<h3 class="muted small" style="margin-top: 0.5rem">{section.title}</h3>
					{#each feeds as feed (feed.id)}
						<div class="card feed" class:off={!feed.enabled}>
							<div class="row" style="justify-content: space-between; gap: 0.6rem">
								<label class="inline" style="margin: 0; font-size: 1rem; color: var(--text)">
									<input type="checkbox" bind:checked={feed.enabled} onchange={touch} />
									<strong>{feed.name}</strong>
								</label>
								<div class="row">
									<button class="ghost tiny" onclick={() => testFeed(feed)}>Test</button>
									<button class="ghost tiny danger" onclick={() => removeFeed(feed.id)}>×</button>
								</div>
							</div>
							<a class="tiny url" href={feed.url} target="_blank" rel="noreferrer noopener"
								>{feed.url}</a
							>
							<div class="row" style="flex-wrap: wrap; gap: 0.3rem; margin-top: 0.5rem">
								{#each config.sections as s (s.id)}
									<button
										class="chip"
										class:on={feed.sections.includes(s.id)}
										onclick={() => toggleFeedSection(feed, s.id)}
									>
										{s.title}
									</button>
								{/each}
							</div>
							{#if testing[feed.id]}
								<p class="tiny muted" style="margin: 0.5rem 0 0">{testing[feed.id]}</p>
							{/if}
						</div>
					{/each}
				{/if}
			{/each}

			{#each config.feeds.filter((f) => f.sections.length === 0) as feed (feed.id)}
				<div class="card feed off">
					<div class="row" style="justify-content: space-between">
						<strong>{feed.name}</strong>
						<button class="ghost tiny danger" onclick={() => removeFeed(feed.id)}>×</button>
					</div>
					<p class="tiny muted" style="margin: 0.3rem 0 0.5rem">
						Not assigned to a section, so it's never read.
					</p>
					<div class="row" style="flex-wrap: wrap; gap: 0.3rem">
						{#each config.sections as s (s.id)}
							<button class="chip" onclick={() => toggleFeedSection(feed, s.id)}>{s.title}</button>
						{/each}
					</div>
				</div>
			{/each}
		</section>

		<section class="stack">
			<h2>Voice</h2>
			<div class="card stack">
				<div>
					<label for="engine">Engine</label>
					<select id="engine" bind:value={config.tts.engine} onchange={touch}>
						<option value="aura">Deepgram Aura — best voice, on the server, uses more allowance</option>
						<option value="kokoro">Kokoro — free and offline, 92MB download, runs on device</option>
						<option value="openrouter">OpenRouter — free cloud voices (Deepgram Flux, Fish Audio), needs a key</option>
						<option value="gemini">Gemini TTS — Google's voices, free tier, a few briefs a day, needs a key</option>
						<option value="melotts">MeloTTS — cheapest, but currently unreliable</option>
					</select>
					{#if config.tts.engine === 'melotts'}
						<p class="tiny" style="color: var(--warn); margin: 0.4rem 0 0">
							Heads up: this model has been returning error 3043 persistently — reports since July
							and every request failing on 15 August. It's by far the cheapest option when it
							works, so it's still here, but try Aura or Kokoro if renders keep failing.
						</p>
					{/if}
				</div>

				{#if config.tts.engine === 'aura'}
					<div>
						<label for="speaker">Aura voice</label>
						<select id="speaker" bind:value={config.tts.auraSpeaker} onchange={touch}>
							{#each AURA_SPEAKERS as s (s.id)}
								<option value={s.id}>{s.name} ({s.gender})</option>
							{/each}
						</select>
					</div>
				{/if}

				{#if config.tts.engine === 'openrouter'}
					<div>
						<label for="or-model">Model</label>
						<select id="or-model" bind:value={config.tts.openrouterModel} onchange={onOpenrouterModelChange}>
							{#each OPENROUTER_MODELS as m (m.id)}
								<option value={m.id}>{m.name}</option>
							{/each}
						</select>
						{#if orModel}
							<p class="tiny muted" style="margin: 0.35rem 0 0">{orModel.note}</p>
						{/if}

						<div style="margin-top: 0.75rem">
							<label for="or-voice">Voice</label>
							{#if orModel?.voices === 'flux'}
								<select id="or-voice" bind:value={config.tts.openrouterVoice} onchange={touch}>
									{#each FLUX_VOICES as v (v)}
										<option value={v}>{fluxVoiceLabel(v)}</option>
									{/each}
								</select>
							{:else if orModel?.voices === 'kokoro'}
								<select id="or-voice" bind:value={config.tts.openrouterVoice} onchange={touch}>
									{#each VOICE_GROUPS as group (group)}
										<optgroup label={group}>
											{#each voicesIn(group) as v (v.id)}
												<option value={v.id}>{voiceLabel(v)}</option>
											{/each}
										</optgroup>
									{/each}
								</select>
							{:else}
								<input
									id="or-voice"
									type="text"
									bind:value={config.tts.openrouterVoice}
									oninput={touch}
									placeholder="fish.audio voice id (32 hex characters)"
									spellcheck="false"
								/>
								<p class="tiny muted" style="margin: 0.35rem 0 0">
									Any public voice on fish.audio works: open it and copy the id from the URL. The
									default is the one OpenRouter uses for its own sample.
								</p>
							{/if}
						</div>

						<p class="tiny muted" style="margin: 0.5rem 0 0">
							Runs on OpenRouter's servers, so the phone does nothing but play the result. The
							server needs an <code>OPENROUTER_API_KEY</code> secret (openrouter.ai/keys, no card).
							Free models are capped per account at 20 requests a minute and {OPENROUTER_FREE_RPD} a
							day — 1,000 a day once the account has ever bought $10 of credit.
						</p>
					</div>
				{/if}

				{#if config.tts.engine === 'gemini'}
					<div>
						<label for="gem-voice">Gemini voice</label>
						<select id="gem-voice" bind:value={config.tts.geminiVoice} onchange={touch}>
							{#each GEMINI_VOICES as v (v.id)}
								<option value={v.id}>{v.id} — {v.tone}</option>
							{/each}
						</select>
						<p class="tiny muted" style="margin: 0.5rem 0 0">
							Google's TTS models via AI Studio, read as one continuous piece in ~3-minute requests. The
							server needs a <code>GEMINI_API_KEY</code> secret (aistudio.google.com/apikey, no card).
							Free tier: {GEMINI_FREE_RPM} requests a minute and {GEMINI_FREE_RPD} a day, so a brief
							takes a couple of minutes to render and there are only a few a day. It's a preview model:
							it occasionally returns nothing for a passage, which is retried and then skipped.
						</p>
					</div>
				{/if}

				{#if config.tts.engine !== 'kokoro'}
					<div>
						<div class="row" style="flex-wrap: wrap">
							<button onclick={previewServer} disabled={serverPreviewing}>
								{serverPreviewing ? 'Rendering…' : `Preview with ${engineLabel(config.tts.engine)}`}
							</button>
							{#if serverPreviewUrl}
								<audio class="server-preview" controls src={serverPreviewUrl} style="max-width: 100%"></audio>
							{/if}
						</div>
						{#if serverPreviewError}
							<p class="tiny" style="color: var(--bad); margin: 0.4rem 0 0">{serverPreviewError}</p>
						{/if}
					</div>
				{/if}

				{#if config.tts.engine === 'kokoro'}
					<div>
						<label for="voice">Kokoro voice</label>
						<select id="voice" bind:value={config.tts.kokoroVoice} onchange={touch}>
							{#each VOICE_GROUPS as group (group)}
								<optgroup label={group}>
									{#each voicesIn(group) as v (v.id)}
										<option value={v.id}>{voiceLabel(v)}</option>
									{/each}
								</optgroup>
							{/each}
						</select>

						<div style="margin-top: 0.75rem">
							<label for="mode">Rendering</label>
							<select id="mode" bind:value={config.tts.kokoroMode} onchange={touch}>
								<option value="">Automatic — CPU, correct everywhere (fp32 on ARM, q8 elsewhere)</option>
								<option value="webgpu-fp32">WebGPU · fp32 — much faster, broken on some GPUs</option>
								<option value="webgpu-q4f16">WebGPU · q4f16 — faster, 154MB, often silent</option>
								<option value="wasm-q8">CPU · q8 — reliable, 92MB</option>
								<option value="wasm-fp32">CPU · fp32 — reliable, best quality, 326MB</option>
							</select>
							<p class="tiny muted" style="margin: 0.35rem 0 0">
								Backend and precision are one setting because they have to agree. CPU is the
								default because it is correct everywhere; WebGPU is several times faster but
								<strong>produces broken audio on some GPUs</strong> — on Intel Xe-LPG it renders
								the back half of every clip quiet and mushy, and q4f16 comes out silent. Try
								WebGPU if you want the speed, and switch back if it sounds wrong.
							</p>
						</div>

						<div class="row" style="margin-top: 0.6rem; flex-wrap: wrap">
							<button onclick={preview} disabled={previewing !== ''}>
								{previewing === config.tts.kokoroVoice ? 'Rendering…' : 'Preview this voice'}
							</button>
							{#if previewUrl}
								<audio controls src={previewUrl} style="max-width: 100%"></audio>
							{/if}
						</div>
						{#if previewError}
							<p class="tiny" style="color: var(--bad); margin: 0.4rem 0 0">{previewError}</p>
						{/if}
						{#if backend}
							<p class="tiny muted" style="margin: 0.4rem 0 0">
								Rendered on <strong>{backend.device}</strong> at <strong>{backend.dtype}</strong>.
							</p>
						{/if}

						<p class="tiny muted" style="margin: 0.5rem 0 0">
							Grades are the model author's estimate of each voice's training data, not an opinion
							about how it sounds — but they predict artefacts well, and the range is wide. Heart
							and Bella are the only A-grade voices; every American male voice is C+ or below.
						</p>
						<p class="tiny muted" style="margin: 0.35rem 0 0">
							Rendering happens on your device, so it costs nothing and works offline. The first
							preview downloads about 92MB, then it's cached.
						</p>
					</div>
				{:else if config.tts.engine === 'melotts'}
					<div>
						<label for="lang">Language</label>
						<select id="lang" bind:value={config.tts.lang} onchange={touch}>
							<option value="en">English</option>
							<option value="es">Spanish</option>
							<option value="fr">French</option>
							<option value="zh">Chinese</option>
							<option value="jp">Japanese</option>
							<option value="kr">Korean</option>
						</select>
					</div>
				{/if}

				<div class="budget">
					<div class="row" style="justify-content: space-between">
						<span class="small">Estimated brief length</span>
						<strong>{totalMinutes.toFixed(1)} min</strong>
					</div>
					{#if config.tts.engine === 'kokoro'}
						<p class="tiny muted" style="margin: 0.4rem 0 0">
							Kokoro renders on your device, so this costs nothing at all and works offline.
						</p>
					{:else if requestCap}
						{#if paidPerBrief}
							<p class="tiny muted" style="margin: 0.4rem 0 0">
								About {requestsPerBrief} request{requestsPerBrief === 1 ? '' : 's'} per brief on a paid
								model: roughly ${paidPerBrief < 0.01 ? paidPerBrief.toFixed(4) : paidPerBrief.toFixed(3)}
								of OpenRouter credit each. No daily cap on paid models.
							</p>
						{:else}
							<div class="bar">
								<div class="fill" class:hot={requestShare > 60} style:width="{requestShare}%"></div>
							</div>
							<p class="tiny muted" style="margin: 0.4rem 0 0">
								About {requestsPerBrief} of the {requestCap} free {engineLabel(config.tts.engine)} requests
								per day ({requestShare}%) — roughly
								{Math.max(1, Math.floor(requestCap / Math.max(1, requestsPerBrief)))} brief{Math.floor(
									requestCap / Math.max(1, requestsPerBrief)
								) === 1
									? ''
									: 's'} a day for everyone sharing the key. Running out fails the render rather than
								charging anyone.
							</p>
						{/if}
					{:else}
						<div class="bar">
							<div class="fill" class:hot={dailyShare > 60} style:width="{dailyShare}%"></div>
						</div>
						<p class="tiny muted" style="margin: 0.4rem 0 0">
							About {neurons.toLocaleString()} of the 10,000 free Workers AI neurons per day ({dailyShare}%)
							— roughly
							{briefsPerDay === Infinity ? 'unlimited' : `${briefsPerDay} brief${briefsPerDay === 1 ? '' : 's'}`}
							a day, shared across everyone on the account. Running out fails the render rather than
							charging you.
						</p>
					{/if}
				</div>
			</div>
		</section>

		<section class="stack">
			<h2>Schedule</h2>
			<div class="card stack">
				<label class="inline">
					<input type="checkbox" bind:checked={config.schedule.enabled} onchange={touch} />
					Build a brief automatically every day
				</label>

				{#if config.schedule.enabled}
					<div>
						<label for="hour">At</label>
						<select
							id="hour"
							value={localHour}
							onchange={(e) => setLocalHour(Number(e.currentTarget.value))}
						>
							{#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
								<option value={h}>{hourLabel(h)}</option>
							{/each}
						</select>
						<p class="tiny muted" style="margin: 0.35rem 0 0">
							{config.timezone} · {String(config.schedule.hourUTC).padStart(2, '0')}:00 UTC. The
							script is written on schedule; audio renders when you open the app, which is what
							keeps this working without any file storage.
						</p>
					</div>
				{/if}
			</div>
		</section>

		<section class="stack">
			<h2>This device</h2>
			<div class="card stack">
				<p class="small muted" style="margin: 0">
					There are no accounts. Your settings live under a random id kept in this browser. Open
					this link on another device to share the same feeds and briefs.
				</p>
				<div class="row">
					<input type="text" readonly value={`${uid}`} aria-label="Your id" />
					<button onclick={copyShareLink}>Copy link</button>
				</div>
				<div>
					<button class="danger ghost" onclick={resetAll}>Reset to defaults</button>
				</div>
			</div>
		</section>
	{/if}
</div>

{#if config && (dirty || saved)}
	<div class="savebar">
		<div class="savebar-inner">
			<span class="small">{saved ? 'Saved' : 'Unsaved changes'}</span>
			<button class="primary" onclick={save} disabled={saving || !dirty}>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</div>
	</div>
{/if}

<style>
	section {
		margin-bottom: 2rem;
	}

	h2 {
		font-size: 1.15rem;
	}

	.grid-2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	@media (max-width: 520px) {
		.grid-2 {
			grid-template-columns: 1fr;
		}
	}

	label.inline {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		font-size: 0.9rem;
		color: var(--text);
	}

	label.inline input[type='checkbox'] {
		width: 1.05rem;
		height: 1.05rem;
		accent-color: var(--accent);
	}

	.off {
		opacity: 0.55;
	}

	.feed .url {
		color: var(--muted);
		text-decoration: none;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.error {
		border-color: #4a2a2e;
		background: #21161a;
		margin-bottom: 1rem;
	}

	.budget {
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}

	.bar {
		height: 6px;
		background: var(--bg);
		border-radius: 999px;
		overflow: hidden;
		margin-top: 0.5rem;
	}

	.fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.2s ease;
	}

	.fill.hot {
		background: var(--warn);
	}

	.savebar {
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

	.savebar-inner {
		max-width: 720px;
		margin: 0 auto;
		padding: 0.7rem 1rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
</style>
