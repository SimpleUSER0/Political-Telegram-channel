# Cloudflare Workers: text-only pilot

The reported failure happened **after** Python installation succeeded. `npx wrangler deploy`
could not find a Worker entrypoint or static assets because the repository originally contained
only a Python/FastAPI/PostgreSQL service. A Python server process is not a Workers entrypoint.

This repository now includes a separate native JavaScript Worker with D1 persistence.
No Railway service, technology bot, existing channel, or Python database is reused or modified.
The Python implementation and its tests remain available independently.

## Build settings in your already-connected Cloudflare project

| Setting | Value |
|---|---|
| Worker name | `political-telegram-channel` |
| GitHub repository | `SimpleUSER0/Political-Telegram-channel` |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `npm ci && npm run check:cloudflare && npm run test:cloudflare` |
| Deploy command | `npx wrangler deploy` |
| Build variable | `SKIP_DEPENDENCY_INSTALL=1` |
| Node version | `24` (build variable `NODE_VERSION=24`, if needed) |

`SKIP_DEPENDENCY_INSTALL` avoids installing the unrelated Python service during the Workers build.
The explicit build command installs the locked Node dependencies. Do not select a static assets
directory, add dummy HTML files, or replace the deploy command with a Python server command.

The root Wrangler configuration binds D1 as `DB` and names the database
`political-telegram-channel-db`. Current Wrangler supports automatic provisioning without a
database ID. On the first successful deployment it creates/binds the database. Subsequent deploys
reuse the binding. If the existing build token does not have permission to provision D1, the
account owner must create a separate D1 database and put its actual `database_id` in the config;
do not reuse another channel's database. Any permission expansion must be reviewed by the owner.
The schema is initialized idempotently on first `/health` or authenticated request.

## Configure runtime variables and secrets

### Gemini free-tier setup

The Worker supports Gemini as well as OpenAI. For a Google AI Studio key use:

| Type | Name | Value |
|---|---|---|
| Secret | `GEMINI_API_KEY` | Your Google AI Studio key |
| Text | `AI_PROVIDER` | `gemini` |
| Text | `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| Text | `DISCOVERY_MODE` | `feeds` |
| Text | `SOURCE_FEEDS` | `bbc-world,guardian-world,civil-ge` |
| Text | `SOURCE_DOMAINS` | `bbc.co.uk,bbc.com,theguardian.com,civil.ge` |

Do not put a Google key in `OPENAI_API_KEY`. In Gemini mode neither an OpenAI key nor
`OPENAI_MODEL` is required. If `AI_PROVIDER` is absent, a `GEMINI_API_KEY` selects Gemini;
otherwise the previous OpenAI default is preserved. Explicit `AI_PROVIDER=gemini` avoids ambiguity.
No error or quota exhaustion triggers fallback to OpenAI or another model.

Google's model documentation checked on 2026-10-16 restricts Gemini 2.5 to previously active
projects; a new project's live 2.5 request returned HTTP 404. The pricing page lists free
text input/output for Gemini 3.5 Flash-Lite, but Google Search grounding is unavailable on
its Free tier. The explicit `feeds` mode therefore discovers actual recent URLs from fixed,
publisher-operated RSS feeds and makes ordinary structured text requests. It never invokes
paid Google Search or falls back to model-written URLs. Account/model/region limits can change;
a free key does not guarantee uninterrupted use. Paid billing can incur charges.
Gemini defaults to **1 research run and 12 API calls daily**, unless you explicitly configure
different caps. A feed run uses about 4–5 model calls; web search adds one. An edit adds a fact
check. HTTP 429 stops the job.

`DISCOVERY_MODE=web_search` retains actual provider search grounding for eligible accounts.
Only exact Google grounding redirect URLs may resolve to allowed publisher domains. The API key
stays in the Google request header and is never forwarded to publishers. JSON is also checked
locally. The existing source retrieval, quote/date/origin checks and mandatory approval remain.
Grounding metadata is retained in the draft's authenticated API response for inspection.
Tests mock Google; live access still requires a closed pilot.

References:
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash
- https://ai.google.dev/gemini-api/docs/generate-content/structured-output
- https://ai.google.dev/gemini-api/docs/generate-content/google-search

After deployment: Worker → Settings → Variables and Secrets. These are **runtime** settings,
not build variables. `keep_vars: true` preserves dashboard values across future deploys.

| Name | Type / value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret; a **new independent political bot** |
| `WEBHOOK_SECRET` | Secret; 32+ random URL-safe characters (`A-Z a-z 0-9 _ -`) |
| `ADMIN_API_TOKEN` | Secret; 32+ random characters |
| `GEMINI_API_KEY` | Secret in Gemini mode; Google AI Studio key |
| `AI_PROVIDER` | `gemini` or `openai` |
| `GEMINI_MODEL` | New free project: `gemini-3.5-flash-lite`; legacy default remains `gemini-2.5-flash` |
| `DISCOVERY_MODE` | `feeds` for free text models; `web_search` (default) for eligible grounded search |
| `SOURCE_FEEDS` | Feed mode: at least two of `bbc-world,guardian-world,civil-ge` |
| `OPENAI_API_KEY` | Secret in OpenAI mode only |
| `EXPECTED_BOT_USERNAME` | New bot username, without `@` |
| `OWNER_USER_ID` | Your numeric Telegram user ID |
| `OWNER_CHAT_ID` | Your positive private chat ID (normally same as user ID) |
| `CHANNEL_ID` | Separate political channel `@username` or `-100...` ID |
| `OPENAI_MODEL` | OpenAI mode only: model supporting Responses, Web Search and Structured Outputs |
| `PUBLIC_BASE_URL` | The actual deployed `https://...workers.dev` origin |
| `SOURCE_DOMAINS` | Comma-separated trusted **public** news/source domains; at least two |
| `SOURCE_ORIGIN_GROUPS` | Optional JSON object mapping known related domains to a shared origin |
| `RESEARCH_ENABLED` | Initially `false`; enable only after reviewing all settings and API budget |
| `PUBLISH_ENABLED` | Initially `false`; enable only for the closed test channel/pilot |
| `SCHEDULE_ENABLED` | Initially `false`; cron still processes manually queued owner commands |
| `SCHEDULE_HOURS` | Initially `[]`; later an array of hours in Asia/Tbilisi |
| `MAX_DAILY_RUNS` | Gemini default `1`, OpenAI default `4` |
| `MAX_DAILY_CALLS` | Gemini default `12`, OpenAI default `40` |
| `MAX_OUTPUT_TOKENS` | Default `4000`, maximum `8000` |
| `MAX_SOURCE_AGE_HOURS` | Default `48` |
| `DRAFT_TTL_HOURS` | Default `12` |

Provider requests may cost money depending on plan, billing and model. Daily run/call caps are hard atomic
reservations; token/search counters reflect returned usage, not a guaranteed currency budget.
The model is intentionally not hard-coded. Source domain choices remain an editorial decision;
no source list is silently treated as trustworthy or independent. Never enter secrets in GitHub
files, URLs, build logs, or chat. Existing technology channel names are explicitly rejected.

## Register and verify Telegram

1. Add the new bot as administrator of a separate closed political test channel, with posting rights.
2. Send `/start` to the new bot in a private chat so it can send you messages.
3. Open the actual Worker `/health`: expect HTTP 200 with `ok:true` and the Workers/D1 runtime.
4. Register the webhook once using a trusted local HTTP client. Set environment variables locally;
   do not paste a real bearer token into shell history or share it in chat.

```bash
curl --request POST "$POLITICAL_WORKER_URL/admin/register-webhook" \
  --header "Authorization: Bearer $POLITICAL_ADMIN_TOKEN"
```

This endpoint checks `getMe` against `EXPECTED_BOT_USERNAME` and checks the target is a separate
channel before registering the webhook. It does not drop pending Telegram updates. Webhook setup
is never performed implicitly on deployment/startup. There is no API endpoint for publishing posts.

An authenticated Cloudflare infrastructure administrator can alternatively insert one explicit
`cf_jobs` row with `kind='setup'`, a unique ID and payload `{"action":"register_webhook"}`.
The next cron claims it once, verifies bot identity and the political channel, registers the
webhook, then verifies `getWebhookInfo`. It records a non-secret summary in
`cf_meta.webhook_registration` and an audit trail. Failed or interrupted jobs are not retried.
No Telegram command or public request can enqueue setup jobs. This path needs D1 write access
but does not require reading bot tokens, webhook secrets or the admin bearer token.

5. `/start` should now respond; `/status` shows missing configuration and queue counters.
6. Enable `RESEARCH_ENABLED=true` for a deliberately limited research test. Send `/news ...`.
7. The minute cron drains the durable queue. A draft appears with **Publish / Edit / Cancel** and
   source links. Human verification remains necessary: inspect sources, dates and attribution.
8. Enable `PUBLISH_ENABLED=true` only for the test publication. Verify one post, then press the
   same button again and confirm that no second channel message appears.
9. Test editing: `/edit ID:VERSION`, then title, blank line, body. Edited text is checked against
   the same evidence packet and gets a new immutable version. Old buttons must be rejected.
10. Restart/redeploy and confirm drafts, versions and unknown-publication state survive in D1.

The initial `/start` sent before webhook registration is not proof of a working webhook; send it
again after registration. Failed owner notifications do not discard completed drafts; `/pending`
and `/show ID` allow recovery. Telegram command handling can be delayed up to a cron interval.

## Reliability and limits

- Exact-version atomic Publish/Edit/Cancel transitions; owner and private chat checked independently.
- An approval audit record is persisted before sending a channel message.
- Telegram timeout, 5xx, lost result or DB failure after a send never causes automatic republication.
  Interrupted `publishing` is later marked `unknown`.
- An unknown publication can only be marked published via authenticated
  `POST /admin/drafts/ID/reconcile` with a positive `message_id` and `confirmed_in_channel:true`.
  The operator must first find the message in the actual channel. This endpoint does not resend.
- Research and edit jobs are serialized; budget reservations and schedule slots are atomic.
- Only actual web-search URLs are accepted; HTTPS/domain/redirect/body-size controls are applied.
  Retrieved text must contain each evidence quote. An additional model checks the final draft.
  These controls do not guarantee factual truth, source independence or correct interpretation.
- Text-only output. The Python version's Commons image pipeline is **not** included in this pilot.
- Admin status and draft lists exist; full Python admin API parity, granular engagement analytics,
  and editorial word limits are not claimed.
- No external PostgreSQL is required. D1 is independent; Python history is not automatically imported.
- Worker/D1/API quotas, network failures, inaccessible publisher pages, and model incompatibilities
  may stop research. The system withholds instead of replacing evidence with model memory.
- The minute cron has a 15-minute interruption cutoff and will not retry unknown side effects.
  Monitor `/status`, Cloudflare logs and the configured daily usage caps.

## Validation

```bash
npm ci
npm run check:cloudflare
npm run test:cloudflare
npx wrangler deploy --dry-run --outdir /tmp/political-worker
npm run dev
```

The Node tests execute the actual SQL against SQLite and mock external APIs. Wrangler dry-run
builds the real Worker bundle. Local runtime smoke testing verifies D1 initialization and safe
unconfigured readiness. None proves that the user's Cloudflare account has deployed successfully
or that live Telegram/OpenAI credentials work. Those require the closed pilot above.

Official references:
- https://developers.cloudflare.com/workers/wrangler/configuration/ (entrypoint, resource provisioning, keep_vars)
- https://developers.cloudflare.com/workers/ci-cd/builds/build-image/ (dependency install settings)
