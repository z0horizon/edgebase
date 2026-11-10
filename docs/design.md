# Design

EdgeBase is one Cloudflare Worker (Hono) with three entry points: `fetch` for HTTP, `queue` for
push delivery, and `scheduled` for crons (`packages/core/src/index.ts`). The code is a pnpm
workspace: `packages/core` is EdgeBase, `apps/server` is the deployable Worker that composes it with
the app's own routes, and `apps/admin` is the admin page (see [extending.md](extending.md)).

```
 Web (cookie) ────┐
 Expo (bearer) ───┼──▶ Worker (Hono, packages/core/src/app.ts)
 Flutter (bearer) ┘     ├─ /api/auth/*        Better Auth                         packages/core/src/auth/
                        ├─ /v1/me, /v1/auth/app-callback                          (user)
                        ├─ /v1/devices        FCM token registration              packages/core/src/push/devices.ts (user)
                        ├─ /v1/inbox/*        inbox                               packages/core/src/inbox/ (user)
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
| `DB` | D1 `edgebase-db` | Better Auth tables (incl. admin, twoFactor, organization), `device`, `scheduled_push`, `push_stats`, `push_open`, `push_template`, `push_idempotency` |
| `INBOX_DB` | D1 `edgebase-inbox` | `inbox_item`, `broadcast`, `inbox_state`, `inbox_push` |
| `PUSH_QUEUE` | Queue `edgebase-push` | push messages (producer and consumer) |
| `PUSH_DLQ` | Queue `edgebase-push-dlq` | pushes that failed 5 attempts |
| `AUTH_RL` | Rate limiting | 10 auth attempts / 60 s per IP |
| `TOPIC_RL` | Rate limiting | 20 web topic changes / 60 s per user |
| Static assets (no binding) | Static assets `apps/server/public/` | the `/admin` page, built from `apps/admin/`, served before the Worker runs |
| `MAIL` | Email Sending | verification and password-reset mail |

## Why it is shaped this way

- **Sessions in D1, no cache.** Every user request reads its session from D1, so sign-out, ban or
  password change take effect on the next request. KV or a cookie cache would delay revocation by
  up to a minute. Smart Placement runs the Worker near D1 to keep that read short, and `updateAge`
  of one day keeps session writes to about one per session per day.
- **Two D1 databases.** The inbox is the largest and most-written table. Keeping it out of `DB`
  keeps sign-in fast and gives each database its own 10 GB. The cost is no foreign key from the
  inbox to `user`; account deletion removes inbox rows in a Better Auth hook.
- **Broadcasts are one row.** A broadcast to every user writes one `broadcast` row; reads merge
  it with personal items, and a per-user watermark marks everything read in one write.
- **FCM without firebase-admin.** The FCM HTTP v1 client signs its own service-account JWT with
  WebCrypto (`packages/core/src/push/fcm.ts`); `firebase-admin` does not run reliably on Workers.
- **Retries per token.** A message that partly fails is re-queued with only the failed tokens,
  so users whose devices already got the push are not sent it again.
- **Writes are budgeted.** Device upserts skip writes inside 7 days, rowid keys avoid extra
  index writes, and every growing table has a TTL (see [specs/data-retention.md](specs/data-retention.md)).

Domain behaviour is in [specs/](specs/README.md); the HTTP API in [api.md](api.md).
