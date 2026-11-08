# Auth and Users

Users sign in through Better Auth, mounted at `/api/auth/*` in the Worker (`src/auth/auth.ts`).
Web clients hold a session cookie; mobile clients send `Authorization: Bearer <token>`. Every
`/v1/*` user route resolves the session from D1 on each request, so a revoked session stops
working on the next request. The system fails closed: without `BETTER_AUTH_SECRET` all auth and
user routes answer `503`.

## Entities

- **`user`** (`migrations/0001_init.sql`): Better Auth columns plus `marketingOptIn` (0/1, default 0).
  Dates are ISO 8601 text, booleans 0/1.
- **`session`**: one row per signed-in device; `expiresAt` indexed for retention.
- **`account`**: one row per sign-in method of a user (`credential`, `google`, `apple`, `github`).
- **`verification`**: email verification, password reset and one-time tokens; `expiresAt` indexed.

## Rules

1. Email sign-up sends a verification email; signing in before verifying answers `403`
   (`requireEmailVerification`). Password reset mails a link. Mail is sent with `ctx.waitUntil`
   so the response does not wait for delivery (`src/auth/auth.ts`, `src/mail.ts`).
2. Google, Apple and GitHub are social providers, each turned on only when both its client ID
   and secret are set (`configuredProviders`); an unset provider answers `404` like an unknown one. Native apps sign in to Google and
   Apple with the platform SDK's ID token through `POST /api/auth/sign-in/social` with
   `{ provider, idToken }`. Google always shows the account picker (`prompt=select_account`).
3. GitHub on native: Expo uses `@better-auth/expo`. Flutter keeps a random `verifier`
   (43–128 chars) and opens the browser OAuth flow with
   `callbackURL = <BASE_URL>/v1/auth/app-callback?challenge=<base64url(SHA-256(verifier))>`.
   That route stores the challenge with a one-time token (3 minutes, in `verification`) and
   answers `302` to `<APP_SCHEME>://auth?token=<token>`. The app redeems it at
   `POST /v1/auth/app-exchange { token, verifier }` for `{ token: <bearer>, user }`
   (`src/auth/app-callback.ts`). Another app that claims the URL scheme gets a token it cannot
   redeem, and a hand-off started by someone else fails the real app's verifier. Failures
   redirect to `<APP_SCHEME>://auth?error=invalid_challenge` or `?error=unauthorized` (no session),
   so the waiting app always hears back. A token is spent
   by its first redemption attempt, right or wrong. Better Auth's own
   `/api/auth/one-time-token/verify` answers `404`, and clients cannot generate one-time tokens.
4. Sessions last 30 days and are extended at most once a day (`updateAge`), so an active session
   costs about one D1 write per day. There is no cookie cache and no secondary storage.
5. Sign-in, sign-up, password-reset, resend-verification and app-exchange requests are limited
   to 10 per minute per `cf-connecting-ip` through the `AUTH_RL` binding; over the limit answers `429 rate_limited`
   (`src/auth/middleware.ts`). Better Auth's own limiter is disabled.
6. `POST /api/auth/delete-user` deletes the user; `session`, `account` and `device` rows cascade,
   and the `afterDelete` hook removes the user's `inbox_item` and `inbox_state` rows from
   `INBOX_DB`, which has no foreign keys (`src/inbox/queries.ts`).
7. Users opt in to marketing pushes with `POST /api/auth/update-user { marketingOptIn: true }`.
8. Browsers on another origin may call the API with credentials when their origin is an
   `http(s)://` entry of `TRUSTED_ORIGINS`; `set-auth-token` is exposed to them (`src/app.ts`).
9. Email sign-ups still unverified after 7 days are deleted by the cleanup cron, unless the user
   also has a social account (see data-retention).
