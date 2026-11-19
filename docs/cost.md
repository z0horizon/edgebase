# Cost

Prices are Cloudflare's list prices when this was written; check the current pricing pages
before relying on the numbers. Row-write counts are estimates from the schema: D1 counts one
write per row and one per index entry it changes, and deletes count too.

## Workers Free ($0)

Free works for development and for a small app that signs in with Google, Apple or GitHub only:

- Email and password sign-in does not: hashing a password takes more than Free's 10 ms CPU per
  request, so sign-up and sign-in fail.
- Mail does not: verification, password reset and invitations need Email Sending, which needs Paid.

Daily limits, reset at 00:00 UTC; past them requests fail instead of costing money:

| Limit per day | Roughly holds |
|---|---|
| 100k Worker requests | ~10k daily users at 10 API calls each (cron uses ~1.5k) |
| 100k D1 rows written | ~40k daily users without inbox items (~2.3 writes each: session, device); ~16k with one personal inbox item each (~6 writes) |
| 5M D1 rows read | ~150k API calls of a few dozen rows |
| 10k Queue operations | ~3,300 messages (24 h retention): thousands of broadcasts, or small `userIds` pushes keeping each consumer batch under Free's 50-subrequest per-invocation limit |
| 500 MB per D1 database | ~1M inbox items, e.g. 10k users × 1 item a day × 30-day TTL ≈ 120 MB |

So expect **up to about 10k daily users**, fewer if clients call the API more often. Requests run
out first; follow the client rules below. Move to Paid when you need email and password, mail,
or more headroom.

## Included in Workers Paid ($5 / month)

| Service | Included | Beyond |
|---|---|---|
| Workers requests | 10M / month | $0.30 / M |
| Workers CPU | 30M ms / month | $0.02 / M ms |
| D1 rows read | 25B / month | $0.001 / M |
| D1 rows written | 50M / month | $1.00 / M |
| D1 storage | 5 GB | $0.75 / GB-month; 10 GB max per database |
| Queues | 1M operations / month | $0.40 / M (a message is about 3 operations) |
| Email Sending | 3,000 outbound emails / month | $0.35 / 1,000 emails (verified destination addresses are free) |
| Workers Logs | 20M log events / month | $0.60 / M (from Dec 1, 2026: shared Cloudflare Observability pricing — 50 GB ingestion + 10 GB-month storage included, then $0.25 / GB and $0.10 / GB-month) |

FCM is free. Logs are sampled at 10% (`observability.head_sampling_rate` in `apps/server/wrangler.jsonc`) and traces at 5%, so 200M requests a month stay within the included observability quota.

## What a push costs

| Push | D1 rows written | Queue messages | Grows with users |
|---|---|---|---|
| Topic broadcast with `inbox: true` | 1 insert + 1 delete by cleanup | 1 | no |
| Topic broadcast with `inbox: false` | 0 | 1 | no |
| To `userIds` with `inbox: true` | ~4 per user (row and index, insert and delete) | 1 per 50 users | yes |
| To `userIds` with `inbox: false` | 0 | 1 per 50 users | yes |
| Each open reported with `POST /v1/opens` | ~5 (key, `user_id` index, `push_stats.opened` increment, and delete after 90 days) | 0 | yes |

So the included 50M row writes hold about 12M personal inbox items a month (~400k a day). A
broadcast is nearly free at any size until clients report opens: then it costs ~5 writes per user
who opens it (`GET /v1/push` reads the pre-aggregated `opened` counter directly without scanning
`push_open`). Every push also writes its `push_stats` row, one update per consumer batch (up to 5
queue messages coalesced), a `scheduled_push` row (insert and delete; immediate pushes skip a
second claim write while fresh) and, with `inbox: true`, one `inbox_push` row,
none of which grows with users. TTL changes storage only: every item is written once and deleted once
whatever its lifetime.

## What an active user costs

Without any push, a signed-in user costs:

| Source | Cost |
|---|---|
| Each API call (`GET /v1/inbox`, `unread-count`, …) | 1 Worker request, a few ms CPU, a few dozen rows read (`GET /v1/inbox` runs in one `INBOX_DB` batch) |
| Session refresh, at most once every `SESSION_REFRESH_DAYS` (default 1) | ~2 writes (row and `session_expires_at` index); with `SESSION_ACTIVITY=on` (default), `lastActiveAt` and the current network update in the background at once on a new country, at most hourly on a new ASN, else every 6 hours (1 unindexed row write); `off` writes none |
| Each sign-in or sign-out | ~5 writes for the `session` row (row, key, token, user and expiry indexes), the same when it is deleted; a remembered 2FA device adds ~5 (`trusted_device`) |
| Device refresh, at most once every 7 days per device | ~2 writes (row and `device_updated_at` index) |

Rows read are cheap: 25B a month cover ~800M reads of a few dozen rows. Requests and the daily
session write are what grow with users, so the client's call pattern matters more than any
server setting.

## Client rules that keep cost down

- Call `POST /v1/sync` once when the app comes to the foreground: it registers the device token,
  reports opens, marks items read and returns the user and the inbox, one request where the
  separate routes take three to five. Batch what happened since the last call into the next one.
- Send other calls together with `POST /v1/batch` (up to 10 per request); it saves requests, not
  row reads or writes.
- Fetch the inbox when the app comes to the foreground or a push arrives, not on a timer.
- Use the `unreadCount` that comes with every `GET /v1/inbox` page; call
  `GET /v1/inbox/unread-count` only to refresh a badge without the list.
- Mark read with `POST /v1/inbox/read-all` (1 write) rather than many `read` calls.
- Register the device token on start; the server writes only when it changed or is 7 days old.
- Report opens only if you use the open stats.
- Back off on `429 rate_limited` for the seconds in `Retry-After`: a user gets 120 calls and 60
  writing calls a minute on the signed-in `/v1` routes (admins are not limited). An app following
  these rules stays far below that; the limit caps what one abusive account can cost (about 360
  D1 row writes a minute at worst, roughly $0.52 a day).

## 1M daily users

Assumptions: one personal inbox item per user per day, 30-day TTL, 10 API calls per user per day
at ~3 ms CPU, one device per user, 10% of users open the daily push.

| Item | Per month | Beyond included |
|---|---|---|
| Requests | 300M | ~$87 |
| CPU | ~900M ms | ~$17 |
| Inbox writes: 30M inserts × 2 + 30M deletes × 2 | 120M | |
| Session refresh (`SESSION_REFRESH_DAYS=1`): 30M × 2 | 60M | |
| Session activity touches: ~1–1.5 per user per day (0 with `SESSION_ACTIVITY=off`) | ~30–45M | |
| Device refresh: ~4.3M × 2 | ~9M | |
| Opens: 3M × 5 | 15M | |
| **Row writes total** | **~235–250M** | **~$185–200** |
| Inbox storage: ~30M rows × ~400 B | **~12 GB** | over the 10 GB limit of `INBOX_DB`; with `DB`, ~$7 beyond the included 5 GB |
| Workers Logs: 300M requests × 10% sampling | 30M events | ~$6 (priced by GB from Dec 1, 2026) |
| Queues: 30M users / 50 per message ≈ 600k messages | ~1.8M operations | under $1 |

Total about **$300–320 / month** plus the $5 plan, and `INBOX_DB` must be sharded or trimmed first.
Not counted: mail beyond the included 3,000 a month ($0.35 per 1,000; with `EMAIL_PASSWORD=off`
only security alerts and organization invitations, and none at all with `EMAIL_SENDING=off`), and sign-ins (~10 writes for a session's
life, small next to daily use).

Mitigations, in order of effect:

1. Follow the client rules above; halving API calls saves ~$50.
2. Send with `inbox: true` only when the push should be kept; many pushes do not need history.
3. Lower `INBOX_TTL_DAYS` to 14–21 (storage only, not writes).
4. Raise `SESSION_REFRESH_DAYS` (1 to 14): session refresh writes fall by that factor (3 saves
   ~$40), and a session may then end up to that many days before 30 days of inactivity.
5. Set `SESSION_ACTIVITY=off` when you do not show users or admins where and when a session was
   last active: saves the activity touches (~$30–45).
6. Shard `INBOX_DB` by a hash of `user_id` (roadmap).

## Write rules built into the code

- Every row written costs one extra write per index it touches; deletes count as writes.
- `inbox_item` uses an integer rowid key (2 writes per insert); a TEXT key would add an
  automatic index (3 writes).
- Device upserts write only on change or after 7 days; session expiry refreshes at most once every `SESSION_REFRESH_DAYS`, and `lastActiveAt` touches are throttled to 6 hours (1 hour on a new ASN, none on a new country; off with `SESSION_ACTIVITY=off`).
- Broadcasts write one row, never one per user; "read all" is one write.
- An open is stored once per user and push (`INSERT OR IGNORE`), so repeated reports write nothing.
