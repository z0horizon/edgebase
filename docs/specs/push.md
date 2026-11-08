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
   written to `INBOX_DB`. The response is `202 { id, users: <eligible count> }`, `id` being the
   push's stats row (see Stats); dispatch adds it to the push's `data` as `pushId`, overwriting a
   caller's own `pushId` key.
4. With `inbox: true`, one `inbox_item` per eligible user (to users) or one `broadcast` row (to a
   topic) is written before enqueueing.
5. User pushes are queued as messages of at most 50 user ids; a topic push is one message.
6. `category` sets delivery priority: `transactional` → Android `HIGH`, channel `default`,
   `apns-priority: 10`; `marketing` → `NORMAL`, channel `promotions`, `apns-priority: 5`
   (`src/push/fcm.ts`, `buildFcmMessage`). Apps must create both Android channels.

## Idempotency

1. `POST /v1/push` with `Idempotency-Key: <1–255 printable ASCII>` claims the key in
   `push_idempotency` before doing anything (`src/push/routes.ts`). The `202` answer is stored and
   replayed with `Idempotent-Replayed: true` to every repeat of the same key for 24 h, so a push
   is dispatched or scheduled once however often the client retries.
2. A repeat with a different body (SHA-256 of the validated body as JSON, so keys inside `data`,
   `vars` and `translations` must keep their order) answers `422
   idempotency_mismatch`; a repeat while the first request still runs answers `409
   idempotency_in_progress`.
3. A `400` or an unexpected error frees the key, so the corrected or retried request runs. A
   Worker killed mid-request leaves the key at `409` until it expires.
4. Without the header nothing changes: every request dispatches.

## Templates and translations

1. `PUT /v1/templates/{name}` (API key, `name` `[a-z0-9_.-]{1,64}`) stores
   `{ title, body, data?, category?, translations? }` with the same limits as a push; at most 500
   templates, a new name past that answers `409 limit_reached` (`src/push/templates.ts`).
   `GET` returns it, `DELETE` removes it.
2. A push may name `template` and pass `vars` (≤ 50, values ≤ 500 chars). Its own `title`,
   `body`, `data`, `category` and `translations` override the template's; then every `{{name}}` in
   the title, body, data values and translations is filled from `vars`. A placeholder without a
   var, an unknown template or a rendered field over its limit answers `400`. Placeholders are
   only filled when a template or `vars` is given.
3. The template is applied when the push is accepted: a scheduled push keeps the text it was
   accepted with even if the template changes.
4. `translations` maps up to 50 BCP 47 tags to `{ title, body }`. Each user gets the translation
   of their `locale` (case-insensitive), else of its language (`vi-VN` → `vi`), else the default
   `title` and `body`; their inbox item holds the same text. Users are queued in groups per
   translation.
5. Topic pushes and broadcasts use the default text: a topic has no per-user locale, so apps that
   need one subscribe to a topic per language.

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

## Stats

1. Every accepted push gets a `push_stats` row: `category`, `users` (eligible users, set at
   dispatch; `0` for a topic), `sent`, `failed`, `send_at` (`sendAt`, or the time it was accepted).
2. The consumer adds FCM's answers per queue message (`src/push/stats.ts`, `recordDelivery`):
   `sent` counts tokens FCM accepted (for a topic, one for the topic), which is not proof the
   device displayed it; `failed` counts dead tokens, dropped requests and tokens whose last retry
   failed. Tokens still being retried count in neither. A stats write that fails is logged and
   never makes Queues resend.
3. `POST /v1/opens { pushId }` (user session) records that the caller opened the push, at most
   once per user and push; an unknown or pruned `pushId` writes nothing and still answers `204`.
   It does not check that the push reached the caller, so `opened` can exceed `users`. Deleting
   the account deletes the user's opens.
4. `GET /v1/push/{id}` (API key) answers `{ id, category, users, sent, failed, opened, sendAt }`,
   `opened` being unique users. Stats and opens are deleted 90 days after `send_at`.

## Topics

Mobile apps subscribe with the FCM SDK (`subscribeToTopic`); the server stores no
subscriptions. Conventions: `all` for broadcasts, `promotions` for marketing.

Web apps cannot subscribe from the Firebase JS SDK, so they call
`POST /v1/topics/{topic}/subscribe { token }` and `/unsubscribe` with a user session
(`src/push/topics.ts`). The token must be a device the caller registered (`404` otherwise). The
Worker calls the Instance ID API (`iid.googleapis.com/iid/v1:batchAdd` / `:batchRemove`) with the
service account's OAuth2 token and `access_token_auth: true`; legacy server keys are not used,
since Google refuses them. Calls share the per-IP auth limit. A non-2xx answer or a per-token error answers `502 upstream_error`;
without `FCM_SERVICE_ACCOUNT` the route answers `503`. Any platform's token works, though native
apps should keep using the SDK.

## Scheduling

1. `POST /v1/push` with `sendAt` stores the request (without `sendAt`, template applied) in
   `scheduled_push` with `send_at` in epoch ms and its stats row's `push_id`, and answers
   `202 { id, scheduled: true }`. Rows stored before `push_id` existed get a stats row at dispatch.
2. A cron every minute (`src/jobs/scheduled.ts`, `enqueueDuePushes`) takes up to 100 due rows in
   `send_at` order and runs the same dispatch as an immediate push, so opt-in and user existence
   are checked at send time. Precision is about one minute.
3. A row is deleted after its dispatch; if dispatch throws, the row stays and is retried on the
   next minute. Right after the inbox rows are written the stored request is rewritten with
   `inbox: false`, so a retry sends the push without writing the inbox again. A row whose stored request no longer validates is logged and deleted.
