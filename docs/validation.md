# Validation record

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
