# Data Retention

Every table that grows has a rule that bounds it. A daily cron (`17 3 * * *`) runs
`runCleanup` (`src/jobs/cleanup.ts`); it logs a JSON report with rows deleted per table and both
databases' sizes (`meta.size_after`), so growth toward D1's 10 GB limit is visible in Workers logs.

## Rules

| Table | Database | Deleted when | Index used |
|---|---|---|---|
| `inbox_item` | `INBOX_DB` | `created_at` older than `INBOX_TTL_DAYS` (default 30) | rowid order |
| `broadcast` | `INBOX_DB` | same as `inbox_item` | rowid order |
| `session` | `DB` | `expiresAt` < now (ISO text compare) | `session_expiresAt` |
| `verification` | `DB` | `expiresAt` < now | `verification_expiresAt` |
| `device` | `DB` | `updated_at` older than 60 days | none (daily scan) |
| `scheduled_push` | `DB` | when dispatched (minute cron) | `scheduled_push_send_at` |
| `inbox_state` | `INBOX_DB` | when the user is deleted | primary key |

1. Deletes run in chunks of 5000 rows (`deleteInChunks`) until a chunk deletes fewer than 5000
   or 20 s have passed; the rest waits for the next day. Short chunks keep D1's single writer
   free for live traffic.
2. Inbox and broadcast rowids grow with time, so `ORDER BY id` meets the expired rows first and
   each chunk reads about as many rows as it deletes.
3. Inbox reads apply the same TTL, so rows past it are hidden even before the cron removes them.
4. Devices refresh at least every 7 days while the app is used (push rule 1), so 60 days without
   a refresh means the app is gone.

## Capacity

Each written row costs one extra write per index it touches, and deletes count as writes.
At 1M users receiving one inbox item a day with a 30-day TTL, `inbox_item` holds ~30M rows
(~12 GB), over D1's 10 GB per database. See [cost.md](../cost.md) for the mitigations.
