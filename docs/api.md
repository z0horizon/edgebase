# HTTP API Reference

## Authentication

- **Users**: a Better Auth session, either the session cookie (web) or `Authorization: Bearer <token>` (mobile).
- **Servers**: `X-API-Key: <PUSH_API_KEY>` on `/v1/push`.

## Errors and status codes

Every error body from EdgeBase routes is `{ "error": { "code": string, "message": string } }`.
Routes under `/api/auth/*` answer in Better Auth's own error format (`{ "code", "message" }`).

| Status | Code | When |
|---|---|---|
| 400 | `invalid_body`, `invalid_cursor` | input failed validation |
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
| GET | `/v1/auth/app-callback` | user | `302` to `<APP_SCHEME>://auth?token=<one-time token>` for native browser OAuth |

## Auth & users

Better Auth's endpoints are documented at https://www.better-auth.com/docs; see
[specs/auth-and-users.md](specs/auth-and-users.md) for how EdgeBase configures them.

### `GET /v1/me`
Answers the session user: `id`, `name`, `email`, `emailVerified`, `image`, `marketingOptIn`,
`createdAt`, `updatedAt`. `401` without a session.

### `GET /v1/auth/app-callback`
Use as the `callbackURL` of a browser OAuth flow started from a native app. Answers `302` to
`<APP_SCHEME>://auth?token=<ott>`; exchange `ott` once at `POST /api/auth/one-time-token/verify`
with `{ "token": ott }` for a session.

## Devices

### `PUT /v1/devices`
Body `{ "token": string (1–4096), "platform": "web" | "ios" | "android" }` → `204`. Call on every
app launch and whenever FCM rotates the token.

### `DELETE /v1/devices/{token}`
→ `204`. Removes the token only when it belongs to the caller.
