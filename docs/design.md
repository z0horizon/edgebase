# Design

EdgeBase is one Cloudflare Worker (Hono) with three entry points: `fetch` for HTTP, `queue` for
push delivery, and `scheduled` for crons (`src/index.ts`).

```
 Web (cookie) ────┐
 Expo (bearer) ───┼──▶ Worker (Hono, src/app.ts)
 Flutter (bearer) ┘     ├─ /api/auth/*        Better Auth                         src/auth/
                        ├─ /v1/me, /v1/auth/app-callback                          (user)
                        ├─ /v1/devices        FCM token registration              src/push/devices.ts (user)
                        ├─ /v1/inbox/*        inbox                               src/inbox/ (user)
                        ├─ /v1/push           send or schedule                    src/push/routes.ts (API key)
                        ├─ queue consumer     FCM HTTP v1, retry, DLQ             src/push/consumer.ts
                        └─ scheduled          * * * * *  due scheduled pushes     src/jobs/scheduled.ts
                                              17 * * * * retention cleanup        src/jobs/cleanup.ts
```

## Bindings

| Binding | Kind | Holds |
|---|---|---|
| `DB` | D1 `edgebase-db` | Better Auth tables, `device`, `scheduled_push` |
| `INBOX_DB` | D1 `edgebase-inbox` | `inbox_item`, `broadcast`, `inbox_state` |
| `PUSH_QUEUE` | Queue `edgebase-push` | push messages (producer and consumer) |
| `PUSH_DLQ` | Queue `edgebase-push-dlq` | pushes that failed 5 attempts |
| `AUTH_RL` | Rate limiting | 10 auth attempts / 60 s per IP |
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
  WebCrypto (`src/push/fcm.ts`); `firebase-admin` does not run reliably on Workers.
- **Retries per token.** A message that partly fails is re-queued with only the failed tokens,
  so users whose devices already got the push are not sent it again.
- **Writes are budgeted.** Device upserts skip writes inside 7 days, rowid keys avoid extra
  index writes, and every growing table has a TTL (see [specs/data-retention.md](specs/data-retention.md)).

Domain behaviour is in [specs/](specs/README.md); the HTTP API in [api.md](api.md).
