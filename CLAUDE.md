# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TransitCast: a personal news podcast. It pulls RSS feeds, has an LLM write a
spoken brief in user-defined sections, and turns that into audio cached on the
device. Runs entirely on Cloudflare's free tier — no object storage, no
database, no accounts.

## Commands

```bash
pnpm dev              # vite dev; proxies the `AI` binding to Cloudflare (needs account_id in wrangler.jsonc), everything else runs locally
pnpm build            # vite build
pnpm check            # svelte-kit sync && svelte-check — the primary type-check/lint step
pnpm check:watch
pnpm deploy           # build + wrangler deploy for both the app and cron/ Workers
pnpm setup            # scripts/setup.js — provisions KV, secrets, deploys both Workers; safe to re-run
pnpm check:tts [origin]  # scripts/check-tts.js — probes deployed MeloTTS with escalating inputs to tell an upstream outage from a bad-input bug
```

There is no test suite. Verify changes with `pnpm check` and, for anything
touching the request pipeline or TTS, manual exercise via `pnpm dev`.

To manually trigger the scheduler without waiting an hour:

```bash
curl "https://transitcast-cron.<subdomain>.workers.dev/?secret=<CRON_SECRET>&hour=13"
```

## Architecture

```
cron (hourly) ──► reads KV, finds due users ──► POST /api/cron
                                                     │
                                    ┌────────────────┴─────────────────┐
                                    │  per feed: GET + parse (24h)     │
                                    │  per section: LLM writes prose   │
                                    └────────────────┬─────────────────┘
                                                     ▼
                                          script JSON in KV (~5KB)
                                                     │
   app opens ──► fetch script ──► per chunk: TTS (server or on-device) ──► IndexedDB
                                                     ▼
                                    play offline, lockscreen controls
```

Three decisions drive everything else in this codebase — read these before
changing the request flow:

- **Audio never touches the server.** It's rendered chunk by chunk on demand
  and stored in IndexedDB on the device (`src/lib/client/db.ts`,
  `src/lib/client/tts.ts`). This is why there's no R2/object storage and why
  briefs still play offline.
- **The client orchestrates; the Worker does one small thing per request.**
  The Workers free plan allows 10ms CPU and 50 subrequests per invocation, so
  `src/lib/pipeline.ts` drives a sequence of tiny HTTP calls rather than doing
  the work in one handler: `/api/feed` fetches exactly one feed, `/api/script`
  writes exactly one section, `/api/tts` speaks exactly one chunk.
  `generateBrief()` in pipeline.ts is the one place this sequence is defined,
  and it runs **identically** in the browser and in the cron path — only
  `base` (URL prefix) and `headers` differ. Don't special-case either caller.
- **Two Workers, not one.** `adapter-cloudflare` overwrites whatever `main`
  points at in `wrangler.jsonc`, so the SvelteKit app's Worker can't also
  carry a hand-written `scheduled` export. The scheduler lives in `cron/` as
  a separate, tiny (~90-line) Worker (`cron/worker.js`) sharing the app's KV
  namespace (`TC_KV`). It only lists due users and fires one `POST /api/cron`
  per user — all actual brief-building logic lives in the main app.

### Directory map

- `src/lib/pipeline.ts` — the orchestration described above; `generateBrief()`
  is the entry point used both client-side and from `/api/cron`.
- `src/lib/server/` — Worker-side logic: `ctx.ts` (platform env + uid
  extraction), `store.ts` (all KV reads/writes and key naming), `rss.ts`
  (feed fetch/parse), `llm.ts` (Groq/OpenAI-compatible chat call),
  `script.ts` (turns items into a section's spoken segments).
- `src/lib/client/` — browser-side: `db.ts` (IndexedDB for cached audio),
  `tts.ts` (renders a brief to audio, either via server TTS or on-device
  Kokoro), `kokoro.ts` / `kokoro-worker.ts` (on-device Kokoro model, run in a
  Worker thread), `api.ts`, `uid.ts` (mints/reads the opaque per-user id).
  `defaults.ts` (default `Config` shape).
- `src/lib/types.ts` — the core domain types (`Config`, `Feed`, `Section`,
  `Item`, `Segment`, `Brief`). Read this first when touching data shapes.
- `src/routes/api/*/+server.ts` — the small per-purpose endpoints described
  above; each does exactly one unit of work (one feed, one section, one TTS
  chunk) to stay under the CPU/subrequest limits.
- `src/routes/settings/+page.svelte` — the actual product surface: users
  define sections (title, LLM instruction, target length, enabled) and feeds
  (which sections they feed), pick a TTS engine/voice, and set a schedule.
- `cron/` — the standalone scheduler Worker; deployed and configured
  separately from the main app (`cron/wrangler.jsonc`).
- `scripts/setup.js` — unattended provisioning (KV namespace, secrets,
  deploy, wiring the scheduler's `APP_ORIGIN`); accepts `GROQ_API_KEY` and
  `CLOUDFLARE_ACCOUNT_ID` as env vars for non-interactive runs.

### Data model / storage

Everything lives in one KV namespace (`TC_KV`), keyed per opaque user id
(minted client-side, kept in `localStorage`, sent as `x-tc-uid` header — see
`src/lib/server/store.ts` and `ctx.ts`). No accounts, no server-side auth
beyond that header plus a shared `CRON_SECRET` for the cron→app call.

- `cfg:<uid>` — the user's `Config` (feeds, sections, tts settings,
  schedule). Written with KV metadata `{ e: enabled, h: hourUTC }` so the cron
  Worker can list due users in one `list()` call instead of reading every
  config.
- `brief:<uid>:latest` — the most recently built `Brief` (script only, no
  audio).
- `seen:<uid>` — a rolling 7-day set of item hashes shown to the model, used
  for cross-day dedupe (separate from the 24h publish-window filter — feeds
  re-date items and aggregators re-post stories, so the window alone isn't
  enough).

### TTS engines

Three interchangeable engines selected via `Config.tts.engine`
(`src/lib/types.ts`), rendered by `src/lib/client/tts.ts`:

- **melotts** (default) — Workers AI, server-side, cheap against the daily
  neuron allowance.
- **aura** — Deepgram Aura, server-side.
- **kokoro** — runs on-device in the browser via `kokoro-js`, in a Web
  Worker (`kokoro-worker.ts`) to avoid blocking the UI thread; needs a ~92MB
  model download on first use and wants shorter input chunks (capped at 300
  chars vs. server engines) or it rushes/slurs.

Swapping the LLM provider (currently Groq) is just `LLM_BASE_URL` +
`LLM_MODEL` in `wrangler.jsonc` plus the `LLM_API_KEY` secret — the endpoint
is treated as OpenAI-compatible.

### Known constraints worth remembering

- Workers free plan: 10ms CPU + 50 subrequests per invocation — this is *why*
  the pipeline is chunked the way it is; don't collapse steps back together.
- Cron builds at most 45 users per run (leaves headroom under the 50
  subrequest cap).
- Hugging Face 404s Kokoro model downloads when the `Referer` header is a
  `*.workers.dev` origin (verified, not a flake) — `src/app.html` sends
  `<meta name="referrer" content="no-referrer">` to route around it. Don't
  remove that meta tag without re-checking this.
- The `AI` binding has no local emulation; `pnpm dev` proxies it to
  Cloudflare, which requires `account_id` to be set in `wrangler.jsonc`.
