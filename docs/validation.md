# Validation record

## Observed remote result — 2026-10-16

Implementation commit `db9c11064ee91d65585feedf88b556d30d9aef62` passed all three jobs:
93 tests on SQLite, 93 tests on PostgreSQL 17, and Docker build plus non-root runtime smoke.
Alembic migration/drift checks passed on both backends. `/health` succeeded in the container;
`/ready` correctly returned 503 without live credentials.

Run: https://github.com/SimpleUSER0/Political-Telegram-channel/actions/runs/38809678310

The first PostgreSQL run exposed a test that inherited DATABASE_URL from CI instead of explicitly
selecting SQLite for the production-rejection check. The corrected test passed on both backends.
Live service deployment, provider access and Telegram publishing remain unverified.

Local checks are run without real OpenAI or Telegram calls. Test data is fictional and uses
reserved `.example` domains. Provider clients and source fetches are replaced only inside tests.

Coverage includes:

- atomic double-Publish protection, cancellation and expiration;
- old version rejection, edit re-checks and revision history;
- persisted approval/publication/audit and restart recovery;
- send timeout, definitive Telegram rejection, cancellation mid-send and DB failure after send;
- webhook secret, owner identity, private chat, matching draft message and update replay;
- authenticated admin routes and no API publication shortcut;
- private/mixed DNS rejection, unsafe URLs, domain suffix confusion and UTF-16 length;
- source provenance, exact evidence excerpt, source age, attribution and origin consistency;
- no unsupported claim/source omission and a complete offline generation path;
- budgets under concurrency, worker claims and schedule deduplication/catch-up;
- license rejection, image hash preservation and changed-image rejection.

GitHub CI runs the suite on SQLite and real PostgreSQL 17, checks Alembic schema drift, syntax,
formatting and lint, and separately builds the Docker image. Check the exact run/commit before
reporting results; a queued build is not a pass.

Not established by these tests: live model availability/features, provider billing, external site
access, live Commons relevance/rights, bot/channel permissions, webhook delivery and Railway runtime.
Those require a private end-to-end pilot with the new project's credentials.

Official integration references used:

- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/tools-web-search

The model is deliberately configurable rather than a hardcoded claim about account access.
