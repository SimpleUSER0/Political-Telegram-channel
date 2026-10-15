# Operations and recovery

## Monitoring

`/health` verifies DB connectivity. `/ready` additionally checks research configuration, bot
configuration and a recent worker heartbeat. Both routes expose no credentials.
Protected `/admin/status` reports job/draft counts and seven days of token/search/call counters.
The scheduler/heartbeat runs independently of long research jobs.

Daily call reservations are atomic and use Asia/Tbilisi day boundaries. Failed/ambiguous API calls
still consume a reservation. SDK automatic retries are disabled so hidden extra calls do not
bypass limits. These caps are **not a dollar spending limit**; configure provider account budget
limits separately. Prices are not hardcoded, and failed calls may have usage unavailable.
Read-only source fetches may fail; no inaccessible text is invented. A failed generation job
is not automatically replayed. Inspect status and request a new run explicitly.

The scheduler catches a configured slot within 15 minutes; it does not flood the queue with old
news after a long outage. A unique database key prevents two jobs for the same date/slot.

## Unknown publication

1. Do not send again. Inspect the independent channel for the exact text/image and timestamp.
2. If found, get its Telegram message ID and use protected `/admin/drafts/{id}/reconcile`.
3. If not found, do not blindly reset the original draft. Investigate delivery logs and prepare a
   newly reviewed revision/event only after confirming no message exists. No automatic retry
   endpoint for ambiguous publication is provided.

`failed` means Telegram returned a definite rejection. Repair permissions/configuration and create
a new reviewable revision or research run; do not bypass approval. Version/event reservations are
conservative: a saved event key cannot be silently reused, including a cancelled/failed draft.
If the same event needs reconsideration, show/review the existing draft; future explicit recovery
workflows should preserve the audit and not silently remove the reservation.

## Pending drafts and failures

A successfully persisted draft can survive owner-notification failure. Find it in `/admin/drafts`
and call `/admin/drafts/{id}/notify` after fixing Telegram. Do not pay to generate it again.
When a job is interrupted, recovery marks it failed after the configured timeout plus 60 seconds.
Never automatically replay a paid generation or an external send.

Article edits must remain supported by their original evidence. New facts need new research.
Expired drafts need re-verification, not a deadline extension. Old buttons cannot approve a new version.

## Database and secrets

- Apply schema changes through Alembic; startup never creates production tables automatically.
- Before schema changes, take a PostgreSQL backup and verify retention/access.
- Test restore into a separate database, check revisions/audit/message IDs, then validate `/health`.
- Do not use test cleanup against a live DB. Tests reject PostgreSQL URLs whose DB name does not end `_test`.
- Rotate bot/API/admin/webhook secrets in the independent project only. Re-register the webhook
  after rotating its secret. Never log full HTTP URLs that include a bot token.
- Source snapshots contain third-party content and should remain in the access-controlled database.
  Establish a retention policy before wider production use; automatic source retention deletion
  is not enabled in this pilot, so audit history is preserved.

## Known practical limits

Automatic claim/origin/date extraction remains model-assisted and fallible. Quote matching proves
text occurrence, not factual truth. Paywalls, JavaScript-only pages, anti-bot responses and missing
dates may block an otherwise valid story. Commons license metadata does not establish all
personality/privacy/trademark rights, and image relevance still requires owner review. All selected
Commons photos are conservatively labeled illustrative/archive, never evidence of the current event.
