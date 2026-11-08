# HTTP API Reference

## Authentication

- **Users**: a Better Auth session, either the session cookie (web) or `Authorization: Bearer <token>` (mobile).
- **Servers**: `X-API-Key: <PUSH_API_KEY>` on `/v1/push`.

## Errors and status codes

Every error body from EdgeBase routes is `{ "error": { "code": string, "message": string } }`.
Routes under `/api/auth/*` answer in Better Auth's own error format (`{ "code", "message" }`).

| Status | Code | When |
|---|---|---|
| 400 | `invalid_body`, `invalid_cursor`, `invalid_limit` | input failed validation |
| 401 | `unauthorized` | no valid session or API key |
| 404 | `not_found` | unknown route or resource |
| 429 | `rate_limited` | auth rate limit hit |
| 500 | `internal` | unexpected error |
| 503 | `not_configured` | a required secret is missing |

## Route summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness, answers `{ "ok": true }` |
| ANY | `/api/auth/*` | varies | Better Auth: sign-up/in, sign-out, social, verify email, reset password, delete user, update user, one-time-token verify |
| GET | `/v1/me` | user | the signed-in user |
| PUT | `/v1/devices` | user | register this device's FCM token |
| DELETE | `/v1/devices/{token}` | user | unregister a token of the caller |
| GET | `/v1/inbox` | user | list inbox items, newest first |
| GET | `/v1/inbox/unread-count` | user | number of unread items |
| POST | `/v1/inbox/read` | user | mark personal items read |
| POST | `/v1/inbox/read-all` | user | mark everything read |
| DELETE | `/v1/inbox/{id}` | user | delete a personal item |
| POST | `/v1/push` | API key | send or schedule a push |
| GET | `/v1/auth/app-callback` | user (cookie) | `302` to `<APP_SCHEME>://auth?token=<one-time token>` for native browser OAuth |
| POST | `/v1/auth/app-exchange` | none | redeem a hand-off token with its verifier for a bearer token |

## Auth & users

Better Auth's endpoints are documented at https://www.better-auth.com/docs; see
[specs/auth-and-users.md](specs/auth-and-users.md) for how EdgeBase configures them.

### `GET /v1/me`
Answers the session user: `id`, `name`, `email`, `emailVerified`, `image`, `marketingOptIn`,
`createdAt`, `updatedAt`. `401` without a session.

### `GET /v1/auth/app-callback?challenge=<c>`
Use as the `callbackURL` of a browser OAuth flow started from a native app, with
`c = base64url(SHA-256(verifier))` (43 chars) for a random `verifier` the app keeps. Answers `302`
to `<APP_SCHEME>://auth?token=<ott>`. Failures also redirect to the app:
`<APP_SCHEME>://auth?error=invalid_challenge` or `<APP_SCHEME>://auth?error=unauthorized` (no session, or
the session was created more than 5 minutes ago).

### `POST /v1/auth/app-exchange`
Body `{ "token": ott, "verifier": string (43–128 chars) }` → `200 { "token": <bearer>, "user": {...} }`.
`401` when the token is unknown, expired, already tried, or the verifier does not match.
`/api/auth/one-time-token/verify` is disabled (`404`).

## CORS

Browsers from an `http(s)://` origin listed in `TRUSTED_ORIGINS` get CORS with credentials,
methods `GET POST PUT DELETE OPTIONS`, headers `content-type, authorization`, and the
`set-auth-token` response header exposed. Other origins get no CORS headers.

## Devices

### `PUT /v1/devices`
Body `{ "token": string (1–4096), "platform": "web" | "ios" | "android" }` → `204`. Call on every
app launch and whenever FCM rotates the token.

### `DELETE /v1/devices/{token}`
→ `204`. Removes the token only when it belongs to the caller.

## Push

### `POST /v1/push`
Header `X-API-Key`. Body:

```json
{
  "to": { "userIds": ["..."] },
  "title": "Order shipped",
  "body": "Your order #123 is on its way",
  "data": { "orderId": "123" },
  "category": "transactional",
  "inbox": true,
  "sendAt": "2026-11-09T08:00:00Z"
}
```

`to` is `{ "userIds": string[1..500] }` or `{ "topic": string }`. `category` is `transactional`
or `marketing`. `data` values must be strings. `inbox` and `sendAt` are optional.

- Now: `202 { "users": n }` with the number of eligible users (`0` for a topic).
- With `sendAt`: `202 { "scheduled": true }`; dispatched within a minute of `sendAt`.
- `400` on invalid input, `401` on a wrong key, `503` when push is not configured.

## Inbox

### `GET /v1/inbox?cursor&limit`
→ `{ "items": InboxEntry[], "nextCursor": string | null, "unreadCount": number }`. `InboxEntry` is
`{ id, kind: "personal" | "broadcast", title, body, data, category, read, createdAt }`.
Pass `nextCursor` back as `cursor` for the next page. `limit` 1–100, default 20. `400 invalid_cursor`
for a cursor this API did not issue; `400 invalid_limit` for a `limit` outside 1–100.

### `GET /v1/inbox/unread-count`
→ `{ "count": number }`. The same number comes with every `GET /v1/inbox` page, so call this one
only to refresh a badge without loading the list.

### `POST /v1/inbox/read`
Body `{ "ids": string[] (≤ 100) }` → `204`. Only `p_` ids are applied.

### `POST /v1/inbox/read-all`
→ `204`.

### `DELETE /v1/inbox/{id}`
→ `204`, or `404` when it is not a personal item of the caller.
