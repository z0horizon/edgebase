# Push

Push notifications go out through Firebase Cloud Messaging HTTP v1. Apps register their FCM
token per device; servers send through `POST /v1/push` with an API key; a queue consumer talks to
FCM and retries per token.

## Devices

### Entities

- **`device`** (`migrations/0001_init.sql`): `token` (primary key), `user_id` (FK `user`, cascade),
  `platform` (`web` | `ios` | `android`), `updated_at` (epoch ms). `WITHOUT ROWID`, `INDEX(user_id)`.

### Rules

1. `PUT /v1/devices { token, platform }` registers the caller's token (`src/push/devices.ts`,
   `upsertDevice`). The row is written only when its owner or platform changed or it is at least
   7 days old, so apps can call it on every launch at near-zero write cost.
2. A token already registered by another user moves to the caller (a shared or resold device).
3. A user keeps at most 10 devices; registering an 11th deletes the least recently updated ones.
4. `DELETE /v1/devices/:token` removes the token only if it belongs to the caller, and answers
   `204` either way. Apps call it on sign-out.
5. `token` is 1–4096 characters.

## Sending

### Rules

1. `POST /v1/push` takes `X-API-Key: <PUSH_API_KEY>`, compared as SHA-256 digests with
   `crypto.subtle.timingSafeEqual`; a user session does not reach it. Missing `PUSH_API_KEY` or
   `FCM_SERVICE_ACCOUNT` answers `503 not_configured` (`src/auth/middleware.ts`, `requireApiKey`).
2. Body limits (`src/push/types.ts`): `userIds` 1–500, `title` 1–120 chars, `body` ≤ 500 chars,
   `data` string map ≤ 1 KB as JSON, `topic` matches FCM's `[a-zA-Z0-9-_.~%]{1,900}`, `sendAt`
   ISO 8601 and in the future.
3. Dispatch (`src/push/dispatch.ts`) keeps only existing, de-duplicated user ids; for
   `category: "marketing"` only users with `marketingOptIn = 1`. Unknown ids are dropped, never
   written to `INBOX_DB`. The response is `202 { users: <eligible count> }`.
4. With `inbox: true`, one `inbox_item` per eligible user (to users) or one `broadcast` row (to a
   topic) is written before enqueueing.
5. User pushes are queued as messages of at most 50 user ids; a topic push is one message.
6. `category` sets delivery priority: `transactional` → Android `HIGH`, channel `default`,
   `apns-priority: 10`; `marketing` → `NORMAL`, channel `promotions`, `apns-priority: 5`
   (`src/push/fcm.ts`, `buildFcmMessage`). Apps must create both Android channels.

## Delivery

### Rules

1. The consumer (`src/push/consumer.ts`) resolves a message's users to their device tokens and
   sends one FCM v1 request per token (FCM v1 has no multicast), 20 at a time.
2. The FCM OAuth token is minted from the service account (RS256 JWT, WebCrypto), cached per
   isolate until 5 minutes before expiry, and shared by concurrent callers. A batch with nothing to
   send never calls Google.
3. `404` / `UNREGISTERED` and `SENDER_ID_MISMATCH` delete the token. `INVALID_ARGUMENT`, `401` and
   other client errors are logged and dropped without deleting, since they usually mean a bad
   payload or credentials, not a dead token.
4. `429`, `5xx`, `UNAVAILABLE`, `INTERNAL`, `QUOTA_EXCEEDED` and network errors are retried by
   enqueueing a new message holding only the failed `{ token, userId }` pairs, delayed by `Retry-After` or
   `30 s × 2^attempt` (capped at 1 h). The fifth failed attempt goes to `PUSH_DLQ` instead.
   Before a retry is sent, each token is checked against `device` again and skipped unless it
   still belongs to the same user, so a token removed at sign-out or moved to another user never
   receives the earlier user's push.
6. `UNAUTHENTICATED` from FCM (our access token rejected, e.g. after a service-account key
   rotation) evicts the cached access token and retries the push.
7. The consumer takes one message per invocation (`max_batch_size: 1`): a message can fan out
   to 500 FCM requests, and this keeps an invocation under the Workers subrequest limit.
5. Once a message's FCM requests have been sent, a failure while deleting dead tokens or
   queueing the retry is logged and the message is still acked, so devices that got the push are
   not sent it again; the cost is a lost retry for the failed tokens. An unexpected error before
   sending calls `message.retry()`; after the queue's `max_retries` (3)
   Cloudflare moves it to the DLQ. The DLQ has no consumer; messages expire there.

## Topics

Mobile apps subscribe with the FCM SDK (`subscribeToTopic`); the server stores no
subscriptions. Conventions: `all` for broadcasts, `promotions` for marketing. Web clients cannot
subscribe to topics client-side and receive per-user pushes only.

## Scheduling

1. `POST /v1/push` with `sendAt` stores the request (without `sendAt`) in `scheduled_push` with
   `send_at` in epoch ms, and answers `202 { scheduled: true }`.
2. A cron every minute (`src/jobs/scheduled.ts`, `enqueueDuePushes`) takes up to 100 due rows in
   `send_at` order and runs the same dispatch as an immediate push, so opt-in and user existence
   are checked at send time. Precision is about one minute.
3. A row is deleted after its dispatch; if dispatch throws, the row stays and is retried on the
   next minute. Right after the inbox rows are written the stored request is rewritten with
   `inbox: false`, so a retry sends the push without writing the inbox again. A row whose stored request no longer validates is logged and deleted.
