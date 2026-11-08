# HTTP API Reference

## Authentication

- **Users**: a Better Auth session, either the session cookie (web) or `Authorization: Bearer <token>` (mobile).
- **Servers**: `X-API-Key: <PUSH_API_KEY>` on `/v1/push`.

## Errors and status codes

Every error body is `{ "error": { "code": string, "message": string } }`.

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
