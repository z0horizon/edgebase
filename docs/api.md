# HTTP API Reference

## Authentication

- **Users**: a Better Auth session, either the session cookie (web) or `Authorization: Bearer <token>` (mobile).
- **Servers**: `X-API-Key: <PUSH_API_KEY>` on `/v1/push`, `/v1/push/*` and `/v1/templates/*`.
  Without that header, these routes also take the session of a user with `role = "admin"` whose
  request carries the Worker's own `Origin` (`BASE_URL`), or no `Origin` on a `GET`; this is what
  the `/admin` page uses. An admin whose session came from email + password and who has no
  two-factor gets `403 two_factor_required` here and on `/api/auth/admin/*`; a session from
  Google, GitHub or Apple sign-in is not asked for it. `get-session` shows which as
  `session.signInProvider` (the provider, or `null`).
- **Captcha** (only when `TURNSTILE_SECRET_KEY` is set): `X-Captcha-Response: <Turnstile token>` on
  `POST /api/auth/sign-up/email`, `/api/auth/request-password-reset` and
  `/api/auth/send-verification-email`. Missing answers `400`, rejected answers `403`. Mobile apps
  get the token by rendering the Turnstile widget in a WebView, since Turnstile has no native SDK.

## Errors and status codes

Every error body from EdgeBase routes is `{ "error": { "code": string, "message": string } }`.
Routes under `/api/auth/*` answer in Better Auth's own error format (`{ "code", "message" }`).

| Status | Code | When |
|---|---|---|
| 400 | `invalid_body`, `invalid_header`, `invalid_cursor`, `invalid_limit` | input failed validation |
| 401 | `unauthorized` | no valid session or API key |
| 404 | `not_found` | unknown route or resource |
| 409 | `idempotency_in_progress`, `limit_reached` | key still running; template cap reached |
| 422 | `idempotency_mismatch` | `Idempotency-Key` reused with another body |
| 429 | `rate_limited` | auth rate limit hit |
| 500 | `internal` | unexpected error |
| 502 | `upstream_error` | Google's Instance ID API refused a topic change |
| 503 | `not_configured` | a required secret is missing |

## Route summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness, answers `{ "ok": true }` |
| ANY | `/api/auth/*` | varies | Better Auth: sign-up/in, sign-out, social, verify email, reset password, delete user, update user, admin, two-factor, organization |
| GET | `/v1/me` | user | the signed-in user |
| PUT | `/v1/devices` | user | register this device's FCM token |
| DELETE | `/v1/devices/{token}` | user | unregister a token of the caller |
| GET | `/v1/inbox` | user | list inbox items, newest first |
| GET | `/v1/inbox/unread-count` | user | number of unread items |
| POST | `/v1/inbox/read` | user | mark personal items read |
| POST | `/v1/inbox/read-all` | user | mark everything read |
| DELETE | `/v1/inbox/{id}` | user | delete a personal item |
| POST | `/v1/push` | API key | send or schedule a push |
| GET | `/v1/push` | API key | stats of the last 50 pushes, newest first |
| GET | `/v1/push/{id}` | API key | delivery and open stats of a push |
| GET | `/v1/templates` | API key | every template (at most 500) |
| PUT / GET / DELETE | `/v1/templates/{name}` | API key | manage a push template |
| GET | `/admin/` | admin (in the page) | admin web page, static assets |
| POST | `/v1/opens` | user | report that the user opened a push |
| POST | `/v1/topics/{topic}/subscribe`, `/unsubscribe` | user | add or remove a device token on a topic (web) |
| GET | `/v1/auth/providers` | none | `{ providers: ["google" \| "github" \| "apple"] }`, those whose credentials are set |
| GET | `/v1/auth/app-callback` | user (cookie) | `302` to `<APP_SCHEME>://auth?token=<one-time token>` for native browser OAuth |
| POST | `/v1/auth/app-exchange` | none | redeem a hand-off token with its verifier for a bearer token |

## Auth & users

Better Auth's endpoints are documented at https://www.better-auth.com/docs; see
[specs/auth-and-users.md](specs/auth-and-users.md) for how EdgeBase configures them.

### `GET /v1/me`
Answers the session user: `id`, `name`, `email`, `emailVerified`, `image`, `marketingOptIn`,
`locale`, `role`, `banned`, `banReason`, `banExpires`, `twoFactorEnabled`, `createdAt`,
`updatedAt`, and `adminNeedsTwoFactor`: true for an admin whose session must set up TOTP before
admin features (a password session without it). `401` without a session.

### Admin, two-factor, organizations
Better Auth's `admin`, `twoFactor` and `organization` plugin routes under `/api/auth/admin/*`,
`/api/auth/two-factor/*` and `/api/auth/organization/*`; limits and flows are in
[specs/auth-and-users.md](specs/auth-and-users.md) rules 11–13. `/api/auth/two-factor/*` is
rate-limited per IP like sign-in.

### `GET /v1/auth/app-callback?challenge=<c>`
Use as the `callbackURL` of a browser OAuth flow started from a native app, with
`c = base64url(SHA-256(verifier))` (43 chars) for a random `verifier` the app keeps. Answers `302`
to `<APP_SCHEME>://auth?token=<ott>`. Failures also redirect to the app:
`<APP_SCHEME>://auth?error=invalid_challenge` or `<APP_SCHEME>://auth?error=unauthorized` (no session, the
session did not come from an OAuth flow for `c`, was already handed off, or is older than 5 minutes).

### `POST /v1/auth/app-exchange`
Body `{ "token": ott, "verifier": string (43–128 chars) }` → `200 { "token": <bearer>, "user": {...} }`.
`401` when the token is unknown, expired, already tried, or the verifier does not match.
`/api/auth/one-time-token/verify` is disabled (`404`).

## CORS

Browsers from an `http(s)://` origin listed in `TRUSTED_ORIGINS` get CORS with credentials,
methods `GET POST PUT DELETE OPTIONS`, headers `content-type, authorization, x-captcha-response`, and the
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
or `marketing`. `data` values must be strings; `data.pushId` is set by the server. `inbox` and
`sendAt` are optional. Optional too:

- `translations`: `{ "<BCP 47 tag>": { "title", "body" } }`, chosen per user by their `locale`.
- `template` + `vars`: start from a stored template and fill its `{{name}}` placeholders; fields
  given in the request override the template's.
- Header `Idempotency-Key`: repeats within 24 h replay the first answer instead of sending again.

Answers:

- Now: `202 { "id": n, "users": n }`, `id` for `GET /v1/push/{id}`, `users` the eligible users
  (`0` for a topic).
- With `sendAt`: `202 { "id": n, "scheduled": true }`; dispatched within a minute of `sendAt`.
- Now, but the send failed after being accepted: `202 { "id": n, "scheduled": true }`; the minute
  cron sends it within about two minutes. Do not retry it.
- `400` on invalid input (also an unknown template or a missing var), `401` on a wrong key,
  `409`/`422` on idempotency conflicts, `503` when push is not configured.

### `GET /v1/push`
→ `{ "pushes": [{ id, category, users, sent, failed, opened, sendAt }] }`, the last 50.

### `GET /v1/push/{id}`
→ `{ id, category, users, sent, failed, opened, sendAt }`; `404` when unknown or older than 90 days.

### `GET /v1/templates`
→ `{ "templates": [{ name, title, body, data?, category?, translations?, updatedAt }] }` by name.

### `PUT /v1/templates/{name}`
Body `{ title, body, data?, category?, translations? }` → `204`. `409 limit_reached` past 500
templates. `GET` returns the stored body, `DELETE` → `204`.

### `POST /v1/opens`
Body `{ "pushId": string }` (the push's `data.pushId`) → `204`. Counted once per user; any
signed-in user can report any live push, so `opened` is a signal, not proof of reach.

### `POST /v1/topics/{topic}/subscribe` and `/unsubscribe`
Body `{ "token": string }`, a token the caller registered with `PUT /v1/devices` → `204`.
`404` for someone else's token, `502` when Google refuses, `503` without `FCM_SERVICE_ACCOUNT`.

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
