# Delivery status — 2026-10-17

## Current deployment: Cloudflare + Gemini

The active implementation is the JavaScript Worker with its independent D1 database.
The older Python/Railway handoff below is historical, not the current activation checklist.

- Worker: `political-telegram-channel`.
- Bot: `@Msofliofokusibot`; political channel: `@Msofliofokusi`.
- Runtime: https://political-telegram-channel.irakli-kardava0.workers.dev
- Live `/ready` returned `ready:true`, no missing settings and a fresh cron heartbeat.
  This reports configuration/cron readiness; it does **not** prove Telegram posting permission.
- Gemini structured access and Telegram webhook registration have successful diagnostic records.
- Scheduled research is enabled at 09:00 and 18:00 Asia/Tbilisi. Posts require owner approval.
- Existing configured daily caps are 10 runs and 24 model calls. Failed attempts consume budget;
  these caps were not raised during this handoff.
- PR #12 merged as `baa307c5c6a084e2cccf5ab5047d936a49eed122`.
  Deployed source inspection confirms ranked candidates, Netgazeti and semantic duplicate checks.
- All 79 Worker tests passed locally. GitHub run 39030090224 passed the Worker, SQLite,
  PostgreSQL and container jobs for the reviewed PR head.

## Live acceptance results and operating limits

1. A fresh infrastructure diagnostic at 12:07 UTC confirms `can_post_messages=true`
   for the expected bot and channel. Earlier missing-permission errors are historical.
2. Research may correctly stop when it cannot establish independent corroboration. Recent
   attempts stopped for missing corroboration or no qualifying candidate. A passing unit test
   is not proof that every live topic will yield a publishable draft. Do not weaken the checks
   or label unsupported claims verified to force output.
3. The bounded live handoff research completed successfully: draft `2d1387162b8a4cfaa112`
   passed the fact check, received an owner approval audit, and Telegram returned message ID 5.
   The publication audit and draft state both confirm publication:
   https://t.me/Msofliofokusi/5 . Duplicate-publication protection passes automated tests;
   an additional live repeated-button test was not performed during this handoff.
4. The daily run budget reached 10/10 (21/24 model calls). Further research on October 17
   is blocked by the existing cap; the UTC daily counter resets at 04:00 Asia/Tbilisi.
   No cap was bypassed or increased.

The assistant initiated research only. The owner approved the resulting publication through
Telegram; publication remains owner-controlled.

---

## Historical Python/Railway handoff (2026-10-16)

## Completed locally

- Independent Python application, PostgreSQL schema/migration, durable jobs and approval state.
- Research/source provenance/claim evidence, fact-checking, licensed image metadata and archive.
- Telegram owner/webhook protection, versioned callbacks, safe ambiguous-send handling.
- Separate interactive/research job lanes, scheduler heartbeat/catch-up and usage limits.
- Dockerfile, Railway config, locked/hash-verified runtime dependencies and CI workflow.
- Georgian README and setup/recovery/validation instructions.

## Verified

- 93 tests passed using SQLite and the same 93 tests passed using PostgreSQL 17 in GitHub CI
  (fictional inputs; no live Telegram/OpenAI calls).
- Ruff lint and formatting, Python compilation, dependency compatibility.
- Alembic migrations and schema-drift checks passed on SQLite and PostgreSQL.
- Actual Uvicorn process startup: `/health` returned 200; `/ready` returned 503 without live configuration.
- Full runtime installed from the hash-locked requirements in a separate environment; application imports checked.

## GitHub delivery

- Initial upload was blocked by repository selection. Access was granted and verified on 2026-10-16.
- The complete implementation was uploaded to `feature/political-newsroom-foundation`.
- Review: https://github.com/SimpleUSER0/Political-Telegram-channel/pull/1
- Remote SQLite/PostgreSQL and Docker build/runtime checks passed for implementation commit
  `db9c11064ee91d65585feedf88b556d30d9aef62`.
- Evidence: https://github.com/SimpleUSER0/Political-Telegram-channel/actions/runs/38809678310
- Docker runtime: non-root container startup succeeded; `/health` passed and unconfigured `/ready` returned 503.

## Remaining infrastructure blocker

- Railway `create_project` failed: `Free plan resource provision limit exceeded. Please upgrade to provision more resources!`
- No Railway project, service, database, domain, secret or deployment was created or changed.

## Not yet verified

- Live OpenAI model/key/Web Search behavior and billing.
- Live source/Commons fetch access and real photo relevance/rights.
- New Telegram bot/channel permissions, webhook delivery and live approval/publishing.

## Owner inputs needed before live activation

New bot username/token, owner chat ID, independent channel ID, dedicated OpenAI key/model,
approved source domains, format word limits and schedule. Secrets go in the new service's private
Variables, never into the repository or chat. Publishing/scheduling remain disabled by default.

The implementation is a tested first engineering version, not a claim of flawless editorial
judgment or a production-verified deployment. Existing technology-channel resources were untouched.
