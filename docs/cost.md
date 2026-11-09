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
| 10k Queue operations | ~3,300 messages: ~165k users reached by `userIds` pushes, or thousands of broadcasts |
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
| Workers Logs | 20M log events / month | $0.60 / M |

FCM is free. Email Sending is billed separately. Logs are sampled at 10%
(`observability.head_sampling_rate` in `apps/server/wrangler.jsonc`), so 200M requests a month stay within the
included log events.

## What a push costs

| Push | D1 rows written | Queue messages | Grows with users |
|---|---|---|---|
| Topic broadcast with `inbox: true` | 1 insert + 1 delete by cleanup | 1 | no |
| Topic broadcast with `inbox: false` | 0 | 1 | no |
| To `userIds` with `inbox: true` | ~4 per user (row and index, insert and delete) | 1 per 50 users | yes |
| To `userIds` with `inbox: false` | 0 | 1 per 50 users | yes |
| Each open reported with `POST /v1/opens` | ~4 (key and `user_id` index, insert and delete after 90 days) | 0 | yes |

So the included 50M row writes hold about 12M personal inbox items a month (~400k a day). A
broadcast is nearly free at any size until clients report opens: then it costs ~4 writes per user
who opens it. Every push also writes its `push_stats` row and one update per queue message, which
does not grow with users. TTL changes storage only: every item is written once and deleted once
whatever its lifetime.

## What an active user costs

Without any push, a signed-in user costs:

| Source | Cost |
|---|---|
| Each API call (`GET /v1/inbox`, `unread-count`, …) | 1 Worker request, a few ms CPU, a few dozen rows read (session, user, inbox page) |
| Session refresh, at most once a day (`updateAge` in `packages/core/src/auth/auth.ts`) | ~2 writes (row and `session_expires_at` index) |
| Device refresh, at most once every 7 days per device | ~2 writes (row and `device_updated_at` index) |

Rows read are cheap: 25B a month cover ~800M reads of a few dozen rows. Requests and the daily
session write are what grow with users, so the client's call pattern matters more than any
server setting.

## Client rules that keep cost down

- Fetch the inbox when the app comes to the foreground or a push arrives, not on a timer.
- Use the `unreadCount` that comes with every `GET /v1/inbox` page; call
  `GET /v1/inbox/unread-count` only to refresh a badge without the list.
- Mark read with `POST /v1/inbox/read-all` (1 write) rather than many `read` calls.
- Register the device token on start; the server writes only when it changed or is 7 days old.
- Report opens only if you use the open stats.

## 1M daily users

Assumptions: one personal inbox item per user per day, 30-day TTL, 10 API calls per user per day
at ~3 ms CPU, one device per user, 10% of users open the daily push.

| Item | Per month | Beyond included |
|---|---|---|
| Requests | 300M | ~$87 |
| CPU | ~900M ms | ~$17 |
| Inbox writes: 30M inserts × 2 + 30M deletes × 2 | 120M | |
| Session refresh: 30M × 2 | 60M | |
| Device refresh: ~4.3M × 2 | ~9M | |
| Opens: 3M × 4 | 12M | |
| **Row writes total** | **~200M** | **~$150** |
| Inbox storage: ~30M rows × ~400 B | **~12 GB** | over the 10 GB limit of `INBOX_DB` |
| Queues: 30M users / 50 per message ≈ 600k messages | ~1.8M operations | under $1 |

Total about **$260 / month** plus the $5 plan, and `INBOX_DB` must be sharded or trimmed first.

Mitigations, in order of effect:

1. Follow the client rules above; halving API calls saves ~$50.
2. Send with `inbox: true` only when the push should be kept; many pushes do not need history.
3. Lower `INBOX_TTL_DAYS` to 14–21 (storage only, not writes).
4. Raise the session `updateAge` to a few days: session writes fall by that factor, and a session
   may then end up to that many days before 30 days of inactivity.
5. Shard `INBOX_DB` by a hash of `user_id` (roadmap).

## Write rules built into the code

- Every row written costs one extra write per index it touches; deletes count as writes.
- `inbox_item` uses an integer rowid key (2 writes per insert); a TEXT key would add an
  automatic index (3 writes).
- Device upserts write only on change or after 7 days; sessions write at most once a day.
- Broadcasts write one row, never one per user; "read all" is one write.
- An open is stored once per user and push (`INSERT OR IGNORE`), so repeated reports write nothing.
