# Design

EdgeBase is one Cloudflare Worker (Hono) with three entry points: `fetch` for HTTP, `queue` for
push delivery, and `scheduled` for crons (`packages/core/src/index.ts`). The code is a pnpm
workspace: `packages/core` is EdgeBase, `apps/server` is the deployable Worker that composes it with
the app's own routes, and `apps/admin` is the admin page (see [extending.md](extending.md)).

```
 Web (cookie) ────┐
 Expo (bearer) ───┼──▶ Worker (Hono, packages/core/src/app.ts)
 Flutter (bearer) ┘     ├─ /api/auth/*        Better Auth                         packages/core/src/auth/
                        ├─ /v1/me, /v1/sessions, /v1/trusted-devices, /v1/auth/app-callback (user)
                        ├─ /v1/devices        FCM token registration              packages/core/src/push/devices.ts (user)
                        ├─ /v1/inbox/*        inbox                               packages/core/src/inbox/ (user)
                        ├─ /v1/realtime       event WebSocket, publish            packages/core/src/realtime/ (user, API key)
                        ├─ /v1/opens, /v1/topics/*  open reports, web topics      packages/core/src/push/stats.ts, topics.ts (user)
                        ├─ /v1/push           send, schedule, stats               packages/core/src/push/routes.ts (API key)
                        ├─ /v1/templates/*    push templates                      packages/core/src/push/templates.ts (API key)
                        ├─ /admin/            admin page (static assets)          apps/admin/ → apps/server/public/admin (admin session)
                        ├─ queue consumer     FCM HTTP v1, retry, DLQ             packages/core/src/push/consumer.ts
                        └─ scheduled          * * * * *  due scheduled pushes     packages/core/src/jobs/scheduled.ts
                                              17 * * * * retention cleanup        packages/core/src/jobs/cleanup.ts
```

## Bindings

| Binding | Kind | Holds |
|---|---|---|
| `DB` | D1 `edgebase-db` | Better Auth tables (incl. admin, twoFactor, passkey, organization), `trusted_device`, `device`, `scheduled_push`, `push_stats`, `push_open`, `push_template`, `push_idempotency` |
| `INBOX_DB` | D1 `edgebase-inbox` | `inbox_item`, `broadcast`, `inbox_state`, `inbox_push` |
| `PUSH_QUEUE` | Queue `edgebase-push` | push messages (producer and consumer) |
| `PUSH_DLQ` | Queue `edgebase-push-dlq` | pushes that failed 5 attempts |
| `REALTIME` | Durable Object `RealtimeHub` | `/v1/realtime` sockets, 16 hubs by user id; no storage |
| `ROOMS` | Durable Object `RealtimeRoom` | one object per room of `/v1/realtime/rooms/:room`, its members' sockets; no storage |
| `AUTH_RL` | Rate limiting | 10 auth attempts / 60 s per IP |
| `TOPIC_RL` | Rate limiting | 20 web topic changes / 60 s per user |
| `EMAIL_RL` | Rate limiting | 5 attempts / 60 s per email address on sign-in, sign-up, password reset and resend verification |
| `USER_RL` | Rate limiting | 120 calls / 60 s per non-admin user on signed-in `/v1` routes (not `/v1/admin/*`) |
| `USER_WRITE_RL` | Rate limiting | 60 writing calls (not GET/HEAD/OPTIONS) / 60 s per user on the same routes |
| Static assets (no binding) | Static assets `apps/server/public/` | the `/admin` page, built from `apps/admin/`, served before the Worker runs |
| `MAIL` | Email Sending | verification, password-reset, invitation and security-alert mail; absent with `EMAIL_SENDING=off` |

## Why it is shaped this way

- **Sessions in D1, no cache.** Every user request reads its session from D1, so sign-out, ban or
  password change take effect on the next request. KV or a cookie cache would delay revocation by
  up to a minute. Smart Placement runs the Worker near D1 to keep that read short, and `updateAge`
  of one day (`SESSION_REFRESH_DAYS`) keeps session writes to about one per session per day.
- **Two D1 databases.** The inbox is the largest and most-written table. Keeping it out of `DB`
  keeps sign-in fast and gives each database its own 10 GB. The cost is no foreign key from the
  inbox to `user`; account deletion removes inbox rows in a Better Auth hook.
- **Broadcasts are one row.** A broadcast to every user writes one `broadcast` row; reads merge
  it with personal items, and a per-user watermark marks everything read in one write.
- **FCM without firebase-admin.** The FCM HTTP v1 client signs its own service-account JWT with
  WebCrypto (`packages/core/src/push/fcm.ts`); `firebase-admin` does not run reliably on Workers.
- **Retries per token.** A message that partly fails is re-queued with only the failed tokens,
  so users whose devices already got the push are not sent it again.
- **Realtime over sharded hubs.** `/v1/realtime` sockets live in 16 Durable Objects picked by a
  hash of the user id, not one per user, so an event to many users or to everyone is at most 16
  calls (the push consumer makes them per batch). Events are not stored: the API stays the
  source of truth, and clients read it on reconnect. Since events can carry data, a hub checks
  the sockets' sessions in D1 before sending (trusting one it found live for 30 s, so frequent
  events do not read every session each time), so any route that deletes a session cuts its
  socket off within half a minute without knowing about sockets. Sockets hibernate and
  `ping` is auto-answered, so idle connections do not wake a hub; the runtime still records each
  ping, so a socket silent for 3 minutes is closed as dead. A hub holds up to 32,000 sockets, so
  16 hubs carry about 512k concurrent connections.
- **API calls ride the personal socket.** A client can send `/v1` calls over its socket; the hub
  runs them through `app.fetch` as that client (the batch route's forwarded headers), so every
  middleware applies and nothing is reimplemented. One socket serves both, at the cost of calls
  sharing their hub's Durable Object with that shard's events.
- **A room is its own object.** Members of a chat or document talk to each other through one
  Durable Object per room, the usual Durable Objects pattern: a message is relayed in place, with
  no hop through the user hubs. A user opens a socket per room. The app decides who joins
  (`canJoin`) and what is relayed (`onMessage`); rooms check sessions at most once a minute,
  since per-message checks would cost a D1 read for every chat line.
- **SQL in named modules.** Every statement lives in a `queries.ts` module, registered by name
  (`src/db/registry.ts`). A test runs `EXPLAIN QUERY PLAN` on each and fails on a full table scan
  without a stated reason, and a sample of invocations (10%, `src/db/metrics.ts`) logs D1 rows
  read and written per statement name, so the cost of a change is visible before and after it ships.
- **One statement per session check.** Better Auth reads the session and its user with one join
  (`advanced.database.joins`) and does not introspect the schema at runtime
  (`validateSchema: false`): an auth instance lives one request, so that check cost about 20
  statements on every request. `test/auth-schema.test.ts` runs the same comparison against the
  migrations instead.
- **Writes are budgeted.** Device upserts skip writes inside 7 days, rowid keys avoid extra
  index writes, and every growing table has a TTL (see [specs/data-retention.md](specs/data-retention.md)).

Domain behaviour is in [specs/](specs/README.md); the HTTP API in [api.md](api.md).
