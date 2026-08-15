# TransitCast

A personal news podcast you can listen to with the screen off. It pulls your RSS
feeds, has an LLM write a spoken brief in sections you define, and turns that into
audio you can cache on your phone for the bus.

Runs entirely on Cloudflare's free tier. No object storage, no database, no
accounts, and no way for it to bill you by accident.

```bash
pnpm install && pnpm wrangler login && pnpm setup
```

That provisions and deploys everything. Details in [Setup](#setup).

## How it's put together

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
   app opens ──► fetch script ──► per chunk: Workers AI MeloTTS ──► IndexedDB
                                                     ▼
                                    play offline, lockscreen controls
```

Three decisions drive everything else:

**Audio never touches the server.** It's rendered chunk by chunk on demand and
stored in IndexedDB on the device. That's what removes the need for R2 or any
other object storage, and it's why the brief still plays when you have no signal.

**The client orchestrates; the Worker does one small thing per request.** The
Workers free plan allows 10ms of CPU and 50 subrequests per invocation. Fetching
a dozen feeds and writing seven sections in one handler blows straight through
both. So `/api/feed` fetches exactly one feed, `/api/script` writes exactly one
section, `/api/tts` speaks exactly one chunk, and `src/lib/pipeline.ts` drives the
sequence. The same pipeline code runs in the browser and in the cron path — only
the base URL and headers differ.

**Two Workers, not one.** `adapter-cloudflare` writes its build output over
whatever `main` points at, so the app's Worker can't also carry a hand-written
`scheduled` export. The scheduler lives in `cron/` as a separate ~90-line Worker
sharing the same KV namespace.

### Why MeloTTS

| | free allowance | per 15-min brief | notes |
|---|---|---|---|
| **Workers AI MeloTTS** | 10,000 neurons/day | ~280 neurons | ~9 hours of speech a day, account-wide |
| Groq Orpheus | 100 req/day, 200 chars/req | ~68 requests | ~22 min/day ceiling, prosody resets every sentence |
| Kokoro-82M (on device) | unlimited | free | 92MB download, renders on the phone |

MeloTTS is the default because it costs a rounding error against the daily
allowance and needs nothing downloaded. Going over the allowance **fails the
request rather than charging you** — there's no card on the account and no way to
run up a bill. Kokoro is available in Settings as an opt-in upgrade: better voice,
zero cost, at the price of a one-time 92MB model download and a slower render.

The LLM deliberately runs on Groq's separate free tier rather than Workers AI,
because the LLM is what would actually eat neurons (~2,400 per brief on a 70B
model versus 280 for the speech). Two independent free tiers, and the expensive
half goes on the one that isn't metered in neurons.

## Setup

You need two free accounts and nothing else: **Cloudflare** (no card required —
the free allowances here fail closed rather than bill) and **Groq**
([console.groq.com/keys](https://console.groq.com/keys)).

```bash
pnpm install
pnpm wrangler login   # opens a browser; skip if already logged in
pnpm setup
```

`pnpm setup` does the whole thing: creates the KV namespace, writes its id into
both configs, generates and sets the shared cron secret, deploys the app and the
scheduler, then points the scheduler at the deployed URL. It's safe to re-run —
it reuses an existing namespace and just redeploys.

It asks for two things: your Groq API key, and which Cloudflare account to use if
your login has more than one. Set both as environment variables and it runs
**fully unattended**, which is the path to hand to an agent:

```bash
GROQ_API_KEY=gsk_... CLOUDFLARE_ACCOUNT_ID=<32-hex-id> pnpm setup
```

`pnpm wrangler whoami` lists your account ids if you don't know them.

When it finishes it prints the live URL. Open it, go to **Settings**, describe
yourself in the first box, then hit **Build today's brief**.

<details>
<summary>Doing it by hand instead</summary>

```bash
# 1. KV namespace — paste the id into BOTH wrangler.jsonc and cron/wrangler.jsonc
pnpm wrangler kv namespace create TC_KV

# 2. Secrets (CRON_SECRET must be the same string in both places)
pnpm wrangler secret put LLM_API_KEY                         # Groq API key
pnpm wrangler secret put CRON_SECRET
pnpm wrangler secret put CRON_SECRET -c cron/wrangler.jsonc

# 3. Deploy both Workers
pnpm deploy
```

Then set `PUBLIC_ORIGIN` in `wrangler.jsonc` and `APP_ORIGIN` in
`cron/wrangler.jsonc` to the deployed URL and run `pnpm deploy` again, so the
scheduler knows where to call.

If your Cloudflare login has more than one account, add `"account_id": "..."` to
both configs.

</details>

### Local development

```bash
pnpm dev
```

The `AI` binding has no local implementation, so `pnpm dev` proxies it to
Cloudflare — which needs `account_id` in `wrangler.jsonc` (`pnpm setup` writes it
for you). Everything else — KV, feed fetching, parsing — runs locally.

### Checking the scheduler without waiting an hour

The cron Worker exposes a manual trigger guarded by the same secret:

```bash
curl "https://transitcast-cron.<subdomain>.workers.dev/?secret=<CRON_SECRET>&hour=13"
```

It reports how many users were due and how many briefs it built.

### Swapping the LLM

Two vars in `wrangler.jsonc` plus the key. The endpoint is OpenAI-compatible, so
hackai, Cerebras and OpenRouter all drop in unchanged:

```jsonc
"LLM_BASE_URL": "https://api.groq.com/openai/v1",
"LLM_MODEL": "openai/gpt-oss-120b"
```

## Customising it

Settings is the actual product. Sections are the unit: each one has a title, an
editorial instruction, a target length, and a set of feeds. Each section is
written by its own LLM pass, so the instruction is followed closely rather than
averaged into one giant prompt. Feeds can serve several sections, and the **Test**
button tells you whether a feed is alive before you rely on it.

Every feed in the default set was checked to return a parseable feed with items
in it. Dead ones were dropped rather than shipped broken.

## Repeats

Two mechanisms, because the publish window alone doesn't do it — feeds re-date
items and aggregators re-post the same story:

- Items outside the configured window (24h by default) never get considered.
- Every item **shown to the model** is recorded in a 7-day seen-set, not just the
  ones it quoted. Otherwise stories the model rejected come back every single day.

## Known limits

- One cron run builds at most 45 users' briefs (50 subrequests per invocation).
- Concatenated MP3 chunks play fine everywhere but report duration only after the
  browser has scanned the file, so the scrubber can take a moment to settle.
- MeloTTS reads most things well but will mangle unusual proper nouns. The script
  prompt asks for numbers and dates to be written out, which covers the common case.
- No accounts yet. Settings live under a random id in `localStorage`, shareable as
  a link. Everything is already keyed by that id, so real auth can be added without
  moving any stored data.
- Abandoned ids get cleaned up automatically. The scheduler stamps a "last
  opened the app" day on every config it sees and, once a day's worth of runs
  have passed, deletes the config/brief/dedupe KV entries for any id that's
  gone `INACTIVE_DAYS` (default 90, set in `cron/wrangler.jsonc`) without a
  visit. Enabling auto-build doesn't count as a visit, so a forgotten schedule
  can't keep an abandoned id alive forever.
