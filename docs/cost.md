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
| 100k Durable Object requests, 13k GB-s | ~100k `/v1/realtime` socket opens; idle sockets hibernate and cost no duration |
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
| Durable Objects (`/v1/realtime`, rooms) | 1M requests, 400k GB-s / month | $0.15 / M requests, $12.50 / M GB-s; a socket opened is 1 request, messages a client sends count 20 to 1, messages sent to it are free; a room is billed duration while it handles messages |
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
| An open `/v1/realtime` socket | 1 Worker and 1 Durable Object request to open; a `ping` a minute is at most 3 Durable Object requests an hour (20 to 1) and does not wake the hub, so no duration; each event (an inbox item, or your `publish`) is at most 16 hub calls in total, not per user, plus one D1 batch per hub checking the receiving sockets' sessions not checked in the last 30 s (rows read grow with those sockets: an event to everyone reads up to one row per open socket, at most twice a minute) |
| An API call over `/v1/realtime` | 1/20 of a Durable Object request plus the hub's duration while the call runs (wall-clock, waiting on D1 included, shared with calls running at the same time) instead of 1 Worker request and its CPU: about $0.06 instead of $0.36 per million calls; the call's D1 reads and writes are unchanged |
| A room message | 1/20 of a Durable Object request and a few ms of the room's duration; relaying it to the other members is free; plus whatever your `onMessage` writes (a D1 row is $1 a million) |

Rows read are cheap: 25B a month cover ~800M reads of a few dozen rows. Requests and the daily
session write are what grow with users, so the client's call pattern matters more than any
server setting.

## Client rules that keep cost down

- Call `POST /v1/sync` once when the app comes to the foreground: it registers the device token,
  reports opens, marks items read and returns the user and the inbox, one request where the
  separate routes take three to five. Batch what happened since the last call into the next one.
- Send other calls together with `POST /v1/batch` (up to 10 per request); it saves requests, not
  row reads or writes.
- Fetch the inbox (and your own data) when the app comes to the foreground, a push arrives, or
  `/v1/realtime` sends an event about it, not on a timer. A client that checked every minute while open spends 60 requests an
  hour; with the socket it spends one to open it and one read per new item. Keep polling only as
  the fallback while no socket can be opened, every few minutes.
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

## Keeping your own code cheap

What EdgeBase already does for its own routes, applied to the code you add in `apps/server`.
Prices and rules are Cloudflare's documentation as read on 2026-11-20.

**Requests (Workers, $0.30 per million beyond the included 10M)**

- Every request that reaches the Worker is billed, including ones it answers `401`, `404` or
  `429`. Send several calls at once with `POST /v1/batch`, and give a screen that is opened often
  one route that returns all it shows.
- Files in `apps/server/public` (static assets) are free and unlimited, unless a path is listed in
  `run_worker_first`. Put data that only changes with a deploy there (a feature-flag file, a
  minimum app version) instead of behind a route.
- Let clients reuse answers: a `Cache-Control: max-age` on a GET that is the same for everyone (as
  `GET /v1/auth/providers` does) saves the request entirely, since the browser or app does not ask.
  Workers Cache (`"cache": { "enabled": true }`) is different: a hit skips your code and its
  CPU and D1 reads, but is still billed as a request, and turning it on also bills static asset
  requests that are free today. It also skips any request with `Authorization`, which is every
  signed-in call from a mobile app.
- Put your own signed-in routes behind `userRateLimit`, and public ones behind a WAF rule on a
  custom domain (see [deployment.md](deployment.md)): a request a zone rule blocks never reaches
  the Worker.

**CPU (30M ms included, then $0.02 per million ms)**

- CPU time, not waiting, is billed: time spent waiting on D1, `fetch` or a queue costs nothing.
  Avoid heavy work per request (large JSON reshaping, crypto in loops, image work); move it to a
  queue consumer or precompute it.
- `limits.cpu_ms` in `wrangler.jsonc` stops an invocation that runs longer than you expect, as a
  guard against a bug or crafted input that loops.

**D1 (rows read $0.001 per million, rows written $1 per million, storage $0.75 per GB-month)**

- Rows read are the rows a query scans, not the ones it returns: a filter on a column without an
  index scans the table. Index the columns you filter and sort on, and check `meta.rows_read` on
  new queries; reads are cheap, but a scan on a large table adds up and slows every request.
- Every index costs one more write per row changed, and deletes are writes. Keep only the indexes
  your queries use; an integer primary key avoids the extra index a TEXT key brings.
- Do not write what has not changed: compare first, or write with a `WHERE` that skips equal rows
  (as device registration does), and throttle "last seen" style updates.
- Send the statements of one request as one `db.batch([...])`: one round trip, and the writes
  succeed or fail together.
- Ad hoc queries from the dashboard or `wrangler d1 execute` are billed like any other.
- Give every growing table a TTL or a cap (see [extending.md](extending.md)); storage beyond 5 GB
  costs, and a database stops at 10 GB.

**Queues ($0.40 per million operations)**

- A message costs about three operations (write, read, delete) per 64 KB, retries add a read each,
  and batching does not reduce the count. Send ids rather than large payloads, and fix a failing
  consumer instead of letting it retry.

**Other storage, when you add it**

- KV costs $5 per million writes, five times a D1 row: use it for data read far more often than
  it changes (configuration, lookups), never for counters or per-request writes.
- R2 has no egress fee; uploads are $4.50 per million and reads $0.36 per million. Serve public
  files from an R2 custom domain, not through the Worker, so a view is not a Worker request.
- Durable Objects bill wall-clock time while an object is active and cannot hibernate; use the
  WebSocket hibernation API and let idle objects sleep. Reserve them for state that needs one
  writer, not as a general database.

**Logs and analytics**

- `observability.head_sampling_rate` defaults to 1 (every request); EdgeBase sets 0.1 for logs and
  0.05 for traces. Keep it low, and log one structured line per event rather than many.
- For your own counters and product metrics, Workers Analytics Engine (10M data points a month
  included, not billed yet) costs less than a D1 row per event.

**Watch the bill**

- Set budget alerts and, if you want a hard stop, a spend limit (dashboard, Billing). The limit
  covers Workers and Durable Objects only and stops the API when reached.
- The D1 dashboard shows rows read and written per database, and `{"event":"cleanup"}` logs show
  database sizes every hour: check both after you ship a new route.

Sources: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers Cache](https://developers.cloudflare.com/workers/cache/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/),
[KV](https://developers.cloudflare.com/kv/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/),
[Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/pricing/),
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Compared with your own servers and Supabase

Rough estimates in USD a month, to show where each option's cost comes from as an app grows. They
rest on list prices read on 2026-11-20 and on the assumptions below, not on measurements: a
different app, user pattern or price list moves every number, so redo the arithmetic with your own
figures before deciding anything on it.

Two workloads, both without mail (`EMAIL_PASSWORD=off`, `EMAIL_SENDING=off`):

- **EdgeBase only**: the assumptions of the 1M example above (10 API calls per user per day).
- **With your app**: 50 calls per user per day in total at ~3 ms CPU, a fifth of the app's own calls
  writing two D1 rows, clients sending them through `POST /v1/sync` and `POST /v1/batch` (about 15
  requests a day), `SESSION_ACTIVITY=off` and `SESSION_REFRESH_DAYS=3`.

The three right-hand columns carry the "with your app" workload elsewhere:

- **Own servers**: virtual servers and a PostgreSQL you rent and operate.
- **Supabase with its sign-in**: the whole backend on Supabase, users signing in through Supabase
  Auth, which is billed per monthly active user. Monthly users are assumed to be three times the
  daily users; an app whose users come back more often pays less than shown.
- **Supabase as database only**: the Worker stays as it is and uses Supabase's PostgreSQL instead
  of D1, so there is no per-user fee.

For both Supabase columns the compute size is a guess at what the load needs (Micro, Large, 2XL,
4XL for the four rows), not a tested figure.

| Daily users | Workers: EdgeBase only | Workers: with your app | Own servers | Supabase with its sign-in | Supabase as database only |
|---|---|---|---|---|---|
| 10k | 5 | 5 | 15–55 | 25 | 25 |
| 100k | ~12 | ~50 | 60–180 | ~775 | ~130 |
| 300k | ~57 | ~250 | ~425 | ~3,000 | ~450 |
| 1M | ~310 | ~960 | ~2,000–2,500 | ~10,400 | ~1,000 |

Supabase at this size is usually priced by agreement, so its list-price figures for 300k and 1M
are an upper bound. It also includes file storage and realtime, which EdgeBase does not have.

How the three columns are built:

- **Own servers**, DigitalOcean list prices. 10k: one 2 GB server with backups ($14), or two
  small app servers and a 2 GiB managed PostgreSQL ($55). 100k: one 8 GB server with daily backups
  ($62), or two 4 GB app servers and an 8 GiB managed PostgreSQL ($180). 300k: two 4-vCPU
  CPU-optimized app servers and a 16 GiB managed PostgreSQL ($425). 1M: four 8-vCPU app servers,
  a 16-vCPU / 64 GB database server with a replica of the same size, a Redis pair and database
  backups. Not counted: the load balancer, standby nodes of the managed database, log storage,
  capacity for the burst after a push to every user, and the people who patch, back up and stay
  on call, which at 1M users cost more than the servers. Budget providers charge less for the
  same hardware; the large clouds more.
- **Supabase with its sign-in** (Pro, $25): $0.00325 per monthly active user beyond 100,000, plus
  the compute size ($10, $110, $410, $960). Moving there means rewriting sign-in, push and the
  inbox on its services.
- **Supabase as database only**: the Worker keeps Better Auth, Queues and crons and reaches
  Supabase's PostgreSQL through Hyperdrive (included in both Workers plans): the plan and the same
  compute sizes. Not counted: the Workers requests and CPU of the "with your app" column without
  its D1 writes (about $220 at 1M users), and the work of porting the queries from D1.

What it comes to:

- Up to about 100k daily users Workers costs the least and needs nobody to run it.
- D1 row writes ($1 a million) are what grows fastest on Workers. From a few hundred thousand
  daily users with an app that writes a lot, a PostgreSQL behind Hyperdrive (managed or your own)
  costs less than D1 while the Worker keeps absorbing bursts.
- A fleet of your own servers is cheaper only on the hardware line; with redundancy, burst
  capacity and operations counted it is not, until you already have a team that runs servers.
- At 1M daily users neither side is simple: `INBOX_DB` passes D1's 10 GB limit and one D1 database
  applies writes one at a time, so plan the data layer (shards, or PostgreSQL) before that size.

Sources: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/),
[Supabase](https://supabase.com/pricing),
[DigitalOcean Droplets](https://www.digitalocean.com/pricing/droplets) and
[managed databases](https://www.digitalocean.com/pricing/managed-databases).

## Measuring D1 per statement

A tenth of requests, queue batches and socket calls, and every cron run, log one line:

```json
{ "event": "d1", "via": "fetch", "path": "/v1/sync",
  "queries": { "inbox.markRead": { "calls": 1, "rowsRead": 3, "rowsWritten": 1, "ms": 0.4 }, "…": {} } }
```

Names are those of `packages/core/src/**/queries.ts` (and yours, if you register them with
`sql()`); Better Auth's are `other:<verb>.<table>`. Filter Workers Logs on `event = "d1"` and
sum `rowsRead` and `rowsWritten` per name to see which statement costs the most. Work left to
`waitUntil` after the response (session activity) is counted, the line logged once it settles;
the session checks hubs and rooms run before sending come as `via: "hub"` and `via: "room"`.
Logs are sampled again by
`head_sampling_rate`, so the line adds about 1% to log events.

What the common calls cost, in D1 statements and round trips (from the test suite):

| Call | Statements | Round trips |
|---|---|---|
| `GET /v1/me`, any session check | 1 (session joined with user) | 1 |
| `GET /v1/inbox` | 1 + 3 in one batch | 2 |
| `POST /v1/sync` with device, read and opens | 1 + 4 in one inbox batch, device and opens beside it | 3–5 |
| Sign-in with email and password | 4 | 4 |

## Write rules built into the code

- Every statement's plan is checked by a test: none scans a whole table except where a bounded
  scan is stated (`scanOk`), so rows read stay proportional to rows needed.
- Better Auth does not introspect the schema at runtime, which would cost about 20 statements per
  request, since an auth instance lives one request.
- Every row written costs one extra write per index it touches; deletes count as writes.
- `inbox_item` uses an integer rowid key (2 writes per insert); a TEXT key would add an
  automatic index (3 writes).
- Device upserts write only on change or after 7 days; session expiry refreshes at most once every `SESSION_REFRESH_DAYS`, and `lastActiveAt` touches are throttled to 6 hours (1 hour on a new ASN, none on a new country; off with `SESSION_ACTIVITY=off`).
- Broadcasts write one row, never one per user; "read all" is one write.
- An open is stored once per user and push (`INSERT OR IGNORE`), so repeated reports write nothing.
