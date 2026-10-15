# Independent Railway setup

Use one new Railway project, one PostgreSQL service named `Postgres`, and one app service.
Never attach this repository to the technology channel's services or copy their variables.

The app's `railway.json` defines Docker build, Alembic pre-deploy migration, `/health`, and one replica.
Keep one replica for this pilot; DB compare-and-swap protects individual sends, but semantic event
selection and expensive research should remain single-consumer until additional load tests exist.

## Variables

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `ADMIN_API_TOKEN` | Independently generated random secret, 32+ characters |
| `OPENAI_API_KEY` | New/dedicated project key, entered privately in Variables |
| `OPENAI_MODEL` | Explicit account-accessible model supporting the used API features |
| `TELEGRAM_BOT_TOKEN` | Independent political bot's token |
| `TELEGRAM_WEBHOOK_SECRET` | Independent random URL-safe secret, 32–128 characters |
| `EXPECTED_BOT_USERNAME` | New bot's public username |
| `OWNER_CHAT_ID` | Owner's numeric private Telegram chat ID |
| `CHANNEL_ID` | New channel's numeric ID or `@username` |
| `PUBLIC_BASE_URL` | New app's HTTPS domain, without `/telegram/webhook` |
| `SOURCE_DOMAINS` | Owner-approved comma-separated source domains |
| `SOURCE_ORIGIN_GROUPS` | Optional JSON object mapping domains to shared origin/ownership |
| `FORMAT_WORD_LIMITS` | Owner-approved JSON object; empty until agreed |
| `WORKER_ENABLED` | `false` during provisioning; `true` after configuration |
| `PUBLISHING_ENABLED` | `false` until private approval tests pass |
| `SCHEDULER_ENABLED` | `false` until the owner agrees a schedule |
| `SCHEDULE_TIMES` | Owner-approved `HH:MM,HH:MM` in Asia/Tbilisi |

Generate secrets locally (do not paste keys into GitHub or public chat):

```bash
python -c 'import secrets; print(secrets.token_urlsafe(40))'
```

## Launch sequence

1. Provision PostgreSQL and configure backups. Enter Variables in the new app only.
2. Connect `SimpleUSER0/Political-Telegram-channel` and choose the reviewed branch/commit.
3. Deploy; require terminal `SUCCESS`, inspect migration/build/runtime output.
4. Generate the app's public domain and set `PUBLIC_BASE_URL`.
5. Set worker true; register the new bot's webhook explicitly with `political-agent register-webhook`
   in the deployed service's shell. It verifies the bot username before registration.
6. Check `/health`, `/ready`, protected `/admin/status`, Telegram `/start` and `/status`.
7. Use a separate test channel, enable publishing, and test Cancel, Edit, expired draft, old buttons,
   concurrent Publish and restart. A live API key/model check is still required.
8. Only after those tests, target the independent production channel. Human approval stays mandatory.
9. Set the schedule only after editorial agreement; enable scheduler last.

Staged Railway resources are preparation only. They have not deployed until the pending changes
are applied and a deployment reaches `SUCCESS`. A healthcheck alone does not prove research works.

No repository push auto-registers a Telegram webhook. No CI job has Telegram/OpenAI secrets.
