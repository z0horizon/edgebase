# Auth and Users

Users sign in through Better Auth, mounted at `/api/auth/*` in the Worker (`src/auth/auth.ts`).
Web clients hold a session cookie; mobile clients send `Authorization: Bearer <token>`. Every
`/v1/*` user route resolves the session from D1 on each request, so a revoked session stops
working on the next request. The system fails closed: without `BETTER_AUTH_SECRET` all auth and
user routes answer `503`.

## Entities

- **`user`** (`migrations/0001_init.sql`): Better Auth columns plus `marketingOptIn` (0/1, default 0)
  and `locale` (BCP 47 or null, `0006`); `role`, `banned`, `banReason`, `banExpires`,
  `twoFactorEnabled` come from the admin and twoFactor plugins (`0004`). Dates are ISO 8601 text,
  booleans 0/1.
- **`session`**: one row per signed-in device; `expiresAt` indexed for retention.
- **`account`**: one row per sign-in method of a user (`credential`, `google`, `apple`, `github`).
- **`verification`**: email verification, password reset, one-time tokens and 2FA challenges; `expiresAt` indexed.
- **`twoFactor`** (`migrations/0004_admin_two_factor_organization.sql`): one row per user with 2FA,
  holding the TOTP secret and backup codes; cascades with the user.
- **`organization`**, **`member`** (cascade with organization and user), **`invitation`**
  (`expiresAt` indexed); `session.activeOrganizationId` and `session.impersonatedBy`.

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
   redirect to `<APP_SCHEME>://auth?error=invalid_challenge` or `?error=unauthorized` (no session, or a
   session older than 5 minutes, so a browser's leftover session cannot be handed to another app),
   so the waiting app always hears back. A token is spent
   by its first redemption attempt, right or wrong. Better Auth's own
   `/api/auth/one-time-token/verify` answers `404`, and clients cannot generate one-time tokens.
4. Sessions last 30 days and are extended at most once a day (`updateAge`), so an active session
   costs about one D1 write per day. There is no cookie cache and no secondary storage.
5. Sign-in, sign-up, password-reset, resend-verification, two-factor, organization invite-member,
   web topic and app-exchange requests are limited
   to 10 per minute per `cf-connecting-ip` through the `AUTH_RL` binding; over the limit answers `429 rate_limited`
   (`src/auth/middleware.ts`). Better Auth's own limiter is disabled.
6. `POST /api/auth/delete-user` and admin `remove-user` delete the user; `session`, `account`,
   `device`, `twoFactor` and `member` rows cascade, and the `databaseHooks.user.delete.after`
   hook removes the user's `inbox_item` and `inbox_state` rows from `INBOX_DB`, which has no
   foreign keys (`src/inbox/queries.ts`), and their `push_open` rows.
7. Users opt in to marketing pushes with `POST /api/auth/update-user { marketingOptIn: true }`.
8. Browsers on another origin may call the API with credentials when their origin is an
   `http(s)://` entry of `TRUSTED_ORIGINS`; `set-auth-token` is exposed to them (`src/app.ts`).
9. Email sign-ups still unverified after 7 days are deleted by the cleanup cron, unless the user
   also has a social account (see data-retention).
10. When `TURNSTILE_SECRET_KEY` is set, `sign-up/email`, `request-password-reset` and
    `send-verification-email` need an `x-captcha-response` header holding a Cloudflare Turnstile
    token: missing answers `400`, rejected by Turnstile answers `403` (Better Auth `captcha`
    plugin, `src/auth/auth.ts`). Unset, these routes need no token. The per-IP limit of rule 5 stops
    one machine; Turnstile stops many machines sending emails to random addresses.
11. Roles come from the Better Auth `admin` plugin: new users get `role = "user"` (rows from before
    `0004` have null, treated the same); `admin` reaches `/api/auth/admin/*` (list, create, remove,
    ban, set role, impersonate, revoke sessions).
    Banning deletes the user's sessions, so the next request answers `401`. The first admin is set
    in D1 (see deployment.md).
12. Two-factor (`twoFactor` plugin) covers email + password sign-in with TOTP and backup codes;
    social sign-in is not challenged. `POST /api/auth/two-factor/enable { password }` returns the
    TOTP URI (issuer: the `BASE_URL` host) and backup codes; 2FA is on once a code is confirmed
    with `verify-totp`. A sign-in of a user with 2FA answers `{ twoFactorRedirect: true }` with
    no session and a 10-minute `two_factor` cookie; `verify-totp` or `verify-backup-code` with that
    cookie creates the session. `/api/auth/two-factor/*` shares rule 5's per-IP limit, and Better
    Auth locks the challenge after repeated wrong codes.
13. Organizations (`organization` plugin): a user belongs to at most 10, an organization has at
    most 100 members and 100 pending invitations, and invitations expire after 48 h. Invitations
    are mailed with `<APP_SCHEME>://invitation?id=<id>`; the app accepts with
    `POST /api/auth/organization/accept-invitation`. A trigger deletes an organization when its
    last member row goes, which happens only when that member's account is deleted.
14. `POST /api/auth/update-user { locale }` sets the language pushes are written in; `null`
    clears it, and anything other than a BCP 47 tag such as `vi` or `en-US` answers `400`.
