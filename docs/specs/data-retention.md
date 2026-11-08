# Data Retention

Every table that grows has a rule that bounds it. An hourly cron (`17 * * * *`) runs
`runCleanup` (`src/jobs/cleanup.ts`) with a 20 s budget; it logs a JSON report with rows deleted
per table, rows read, whether it finished (`complete`), and both databases' sizes
(`meta.size_after`). An unfinished run is logged with `console.warn` and continues next hour.

## Rules

| Table | Database | Deleted when | Index used |
|---|---|---|---|
| `inbox_item` | `INBOX_DB` | `created_at` older than `INBOX_TTL_DAYS` (default 30) | rowid order |
| `broadcast` | `INBOX_DB` | same as `inbox_item` | rowid order |
| `session` | `DB` | `expiresAt` < now (ISO text compare) | `session_expires_at` |
| `verification` | `DB` | `expiresAt` < now | `verification_expires_at` |
| `device` | `DB` | `updated_at` older than 60 days | `device_updated_at` |
| `user` (+ cascades) | `DB` | email unverified and created more than 7 days ago, with no social account | `user_unverified_created_at` (partial) |
| `scheduled_push` | `DB` | when dispatched (minute cron) | `scheduled_push_send_at` |
| `inbox_state` | `INBOX_DB` | when the user is deleted | primary key |

1. Deletes run in chunks of 5000 rows (`deleteInChunks`) until a chunk deletes fewer than 5000
   or the 20 s budget is spent; the rest waits for the next hour. Deleted rows are counted from
   `RETURNING`, since D1's `meta.changes` also counts cascaded rows. Short chunks keep D1's single writer
   free for live traffic.
2. Inbox and broadcast rowids grow with time, so every row below the first fresh rowid is
   expired. Each chunk looks up that rowid (stopping at the first fresh row) and deletes only
   below it, so cleanup never walks the fresh part of the table. A row written with a clock far
   behind its neighbours is deleted late, never early.
3. Inbox reads apply the same TTL, so rows past it are hidden even before the cron removes them.
4. Devices refresh at least every 7 days while the app is used (push rule 1), so 60 days without
   a refresh means the app is gone.

## Capacity

Each written row costs one extra write per index it touches, and deletes count as writes.
At 1M users receiving one inbox item a day with a 30-day TTL, `inbox_item` holds ~30M rows
(~12 GB), over D1's 10 GB per database. See [cost.md](../cost.md) for the mitigations.
