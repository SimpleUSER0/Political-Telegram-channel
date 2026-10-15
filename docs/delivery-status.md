# Delivery status — 2026-10-16

## Completed locally

- Independent Python application, PostgreSQL schema/migration, durable jobs and approval state.
- Research/source provenance/claim evidence, fact-checking, licensed image metadata and archive.
- Telegram owner/webhook protection, versioned callbacks, safe ambiguous-send handling.
- Separate interactive/research job lanes, scheduler heartbeat/catch-up and usage limits.
- Dockerfile, Railway config, locked/hash-verified runtime dependencies and CI workflow.
- Georgian README and setup/recovery/validation instructions.

## Verified

- 93 offline tests passed using SQLite (fictional inputs; no live Telegram/OpenAI calls).
- Ruff lint and formatting, Python compilation, dependency compatibility.
- Alembic migration applied and schema-drift check passed on SQLite.
- Actual Uvicorn process startup: `/health` returned 200; `/ready` returned 503 without live configuration.
- Full runtime installed from the hash-locked requirements in a separate environment; application imports checked.

## External blockers actually observed

- GitHub `create_file` returned 403: `Resource not accessible by integration`.
- GitHub installation 168970598 has `repository_selection=selected`; this new repository is not
  among its four permitted repositories. Public reads do not imply write permission.
- Add **Political-Telegram-channel** at https://github.com/settings/installations/168970598 and save.
- Railway `create_project` failed: `Free plan resource provision limit exceeded. Please upgrade to provision more resources!`
- No Railway project, service, database, domain, secret or deployment was created or changed.

## Not yet verified

- GitHub push/PR/CI; repository remains empty because the write attempt failed.
- Real PostgreSQL concurrency/migrations and Docker image build (configured in CI but not executed).
- Live OpenAI model/key/Web Search behavior and billing.
- Live source/Commons fetch access and real photo relevance/rights.
- New Telegram bot/channel permissions, webhook delivery and live approval/publishing.

## Owner inputs needed before live activation

New bot username/token, owner chat ID, independent channel ID, dedicated OpenAI key/model,
approved source domains, format word limits and schedule. Secrets go in the new service's private
Variables, never into the repository or chat. Publishing/scheduling remain disabled by default.

The implementation is a tested first engineering version, not a claim of flawless editorial
judgment or a production-verified deployment. Existing technology-channel resources were untouched.
