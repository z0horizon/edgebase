# Auth and Users

Users sign in through Better Auth, mounted at `/api/auth/*` in the Worker (`packages/core/src/auth/auth.ts`).
Web clients hold a session cookie; mobile clients send `Authorization: Bearer <token>`. Every
`/v1/*` user route resolves the session from D1 on each request, so a revoked session stops
working on the next request. The system fails closed: without `BETTER_AUTH_SECRET` all auth and
user routes answer `503`.

## Entities

- **`user`** (`packages/core/migrations/0001_init.sql`): Better Auth columns plus `marketingOptIn` (0/1, default 0),
  `locale` (BCP 47 or null, `0006`), `twoFactorEnabledAt` and `passwordChangedAt` (`0008`); `role`,
  `banned`, `banReason`, `banExpires`, `twoFactorEnabled` come from the admin and twoFactor plugins
  (`0004`). Dates are ISO 8601 text, booleans 0/1.
- **`session`**: one row per signed-in device; `expiresAt` indexed for retention. `signInProvider`
  (`0007`) is the passwordless provider that created it (`google`, `github`, `apple`, `passkey`) or null; `0008`
  adds current edge network (`asn`, `asOrganization`, `country`, `city`), initial sign-in network
  (`createdIp`, `createdAsn`, `createdAsOrganization`, `createdCountry`, `createdCity`),
  `lastActiveAt`, and 2FA provenance (`twoFactorMethod`: `totp` | `backup_code` | `trusted_device`
  | null, `twoFactorVerifiedAt`). Clients cannot set any of these columns.
- **`passkey`** (`0009`): one row per WebAuthn / FIDO2 credential (`@better-auth/passkey`, capped at
  20 per user, `credentialID` unique, `userId` indexed, cascades with `user`); holds `name` (`<= 64`
  chars), `publicKey`, `counter`, `deviceType`, `backedUp`, `transports`, `aaguid`, `createdAt`.
- **`trusted_device`** (`0008`): one row per 30-day 2FA-trusted browser or native app (capped at 20
  per user, `expires_at` indexed for cleanup, cascades with `user`); stores only `base64url(SHA-256(token))`
  plus user agent, origin network (`created_ip`, `created_asn`, `created_country`), last-used
  network (`ip_address`, `asn`, `as_organization`, `country`, `city`), and epoch-ms `created_at`,
  `last_used_at`, `expires_at`.
- **`account`**: one row per sign-in method of a user (`credential`, `google`, `apple`, `github`).
- **`verification`**: email verification, password reset, one-time tokens and 2FA challenges; `expiresAt` indexed.
- **`twoFactor`** (`packages/core/migrations/0004_admin_two_factor_organization.sql`): one row per user with 2FA,
  holding the TOTP secret and backup codes; cascades with the user.
- **`organization`**, **`member`** (cascade with organization and user), **`invitation`**
  (`expiresAt` indexed); `session.activeOrganizationId` and `session.impersonatedBy`.

## Rules

1. Email sign-up sends a verification email; signing in before verifying answers `403`
   (`requireEmailVerification`). Password reset mails a link. Mail is sent with `ctx.waitUntil`
   so the response does not wait for delivery (`packages/core/src/auth/auth.ts`, `packages/core/src/mail.ts`).
   `EMAIL_PASSWORD=off` turns email and password off for apps that sign in only with providers or
   passkeys: `/api/auth/sign-in/email`, `/sign-up/email`, `/request-password-reset`,
   `/reset-password[/*]`, `/change-password` and `/send-verification-email` answer `404`, so no
   password is set and no account mail is sent; existing sessions keep working. Default `on`.
   `APP_NAME` (default `EdgeBase`) names the product to people: mail subjects start with
   `<APP_NAME>: `, and it is the TOTP issuer and the passkey relying-party name.
2. Google, Apple and GitHub are social providers, each turned on only when both its client ID
   and secret are set (`configuredProviders`); an unset provider answers `404` like an unknown one.
   `GOOGLE_CLIENT_ID` accepts a comma-separated list (web client ID first, followed by optional
   iOS/Android client IDs accepted as `idToken` audiences). Native apps sign in to Google and
   Apple with the platform SDK's ID token through `POST /api/auth/sign-in/social` with
   `{ provider, idToken: { token, nonce?, accessToken? } }`. Google always shows the account picker
   (`prompt=select_account`).
3. GitHub on native: Expo uses `@better-auth/expo`. Flutter keeps a random `verifier`
   (43–128 chars) and opens the browser OAuth flow with
   `callbackURL = <BASE_URL>/v1/auth/app-callback?challenge=<base64url(SHA-256(verifier))>`.
   The OAuth callback binds that `challenge` to the new session (3 minutes, single-use in
   `verification`); `/v1/auth/app-callback` consumes that binding, stores the challenge with a
   one-time token (3 minutes, in `verification`) and
   answers `302` to `<APP_SCHEME>://auth?token=<token>`. The app redeems it at
   `POST /v1/auth/app-exchange { token, verifier }` for `{ token: <bearer>, user }`
   (`packages/core/src/auth/app-callback.ts`). Another app that claims the URL scheme gets a token it cannot
   redeem, and a hand-off started by someone else fails the real app's verifier. Failures
   redirect to `<APP_SCHEME>://auth?error=invalid_challenge` or `?error=unauthorized` (no session, a
   session that did not come from an OAuth flow for that `challenge`, a second hand-off on the same
   session, or a session older than 5 minutes, so a browser's session cannot be handed to another app),
   so the waiting app always hears back. A token is spent
   by its first redemption attempt, right or wrong. Better Auth's own
   `/api/auth/one-time-token/verify` answers `404`, and clients cannot generate one-time tokens.
4. Sessions last 30 days and are extended at most once a day (`updateAge`), with a 15-minute
   `freshAge` for passwordless sensitive operations (`delete-user`, `unlink-account`, `passkey`
   add/rename/delete), and are capped at 30 active sessions per user (pruning the oldest on
   sign-in). Better Auth's raw-token `/api/auth/list-sessions`, `/api/auth/admin/list-user-sessions`,
   `/api/auth/get-access-token`, `/api/auth/refresh-token` and `/api/auth/account-info` endpoints
   are disabled (`404`) in favour of token-free `/v1/sessions` and `/v1/admin/users/{userId}/sessions`.
   There is no cookie cache and no secondary storage. Client IP comes from `cf-connecting-ip` and ASN/ISP/geo
   from Cloudflare `request.cf`. Active `/v1/*` calls refresh `lastActiveAt` and the current
   network in `ctx.waitUntil` at most every 60 minutes or immediately when `asn` or `country`
   changes, never altering `createdIp`/`createdAsn`/`createdCountry` and never revoking a roaming
   mobile session. When an established user completes sign-in from an `(asn, country)` pair not
   present among their other unexpired sessions or trusted devices, a transactional inbox alert and
   email are sent via `ctx.waitUntil` (capped at 3 alerts per hour per user).
5. Sign-in, sign-up, password-reset (`request-password-reset`, `reset-password`),
   `change-password`, `verify-password`, `delete-user`, `link-social`, `unlink-account`,
   resend-verification, two-factor, passkey ceremony (`generate-*`, `verify-*`), organization
   invite-member and app-exchange requests are limited to 10 per minute per `cf-connecting-ip`
   (normalized to `/64` on IPv6) through the `AUTH_RL` binding; over the limit answers `429 rate_limited`
   (`packages/core/src/auth/middleware.ts`). Better Auth's own limiter is disabled.
   Signed-in `/v1` routes (`/v1/me`, sessions, trusted devices, devices, inbox, opens, topics; not
   `/v1/admin/*`) allow a non-admin user 120 calls a minute (`USER_RL`), of which at most 60 may
   write (`USER_WRITE_RL`: any method but GET/HEAD/OPTIONS); over either answers `429 rate_limited`.
   Admins are not limited, since the admin page reads a failed `/v1/me` as signed out. Every
   `429 rate_limited` carries `Retry-After: 60`. The bindings count per Cloudflare location, so they
   bound cost rather than enforce an exact quota.
6. `POST /api/auth/delete-user` and admin `remove-user` delete the user; `session`, `account`,
   `device`, `trusted_device`, `passkey`, `twoFactor` and `member` rows cascade, and the `databaseHooks.user.delete.after`
   hook removes the user's `inbox_item` and `inbox_state` rows from `INBOX_DB`, which has no
   foreign keys (`packages/core/src/inbox/queries.ts`), and their `push_open` rows.
7. Users opt in to marketing pushes with `POST /api/auth/update-user { marketingOptIn: true }`.
8. Browsers on another origin may call the API with credentials when their origin is an
   `http(s)://` entry of `TRUSTED_ORIGINS`; `set-auth-token` and `set-trust-device-token` are exposed to them (`packages/core/src/app.ts`).
   State-changing `/v1/*` calls authenticated via cookie (without `Authorization: Bearer`) must send
   `Origin` matching `BASE_URL` or an `http(s)://` `TRUSTED_ORIGINS` entry (`403 forbidden_origin` otherwise).
   All incoming `/api/auth/*` and `/v1/*` request bodies are capped at 64 KB (`413 payload_too_large`),
   and `user` / `organization` text columns (`name`, `email`, `image`, `banReason`, `slug`, `logo`, `metadata`)
   enforce bounded lengths on write.
9. Email sign-ups still unverified after 7 days are deleted by the cleanup cron along with any
   `inbox_item`, `inbox_state` and `push_open` rows, unless the user
   also has a social account (see data-retention).
10. When `TURNSTILE_SECRET_KEY` is set, `sign-up/email`, `request-password-reset` and
    `send-verification-email` need an `x-captcha-response` header holding a Cloudflare Turnstile
    token: missing answers `400`, rejected by Turnstile answers `403` (Better Auth `captcha`
    plugin, `packages/core/src/auth/auth.ts`). Unset, these routes need no token. The per-IP limit of rule 5 stops
    one machine; Turnstile stops many machines sending emails to random addresses.
11. Roles come from the Better Auth `admin` plugin: new users get `role = "user"` (rows from before
    `0004` have null, treated the same); `admin` reaches `/api/auth/admin/*` (list, create, remove,
    ban, set role, impersonate, revoke sessions), but a password session needs two-factor on:
    until then it answers `403 two_factor_required` there and on the admin-session routes of
    api.md, so a leaked password alone reaches nothing. Setting up 2FA or registering the admin's
    very first passkey stays open only when `0` passkeys and `0` social accounts exist; once any
    passkey or social account is linked, a plain password session cannot enroll a passkey or enable
    TOTP (`403 TWO_FACTOR_REQUIRED`). A session from social sign-in or a WebAuthn passkey
    (`signInProvider` set to `google`, `github`, `apple` or `passkey`) passes without TOTP, since
    the provider's own sign-in or hardware/biometric `userVerification: "required"` is the second
    wall. So a provider account joins an admin only through `POST /api/auth/link-social` from that
    admin's session that itself passes this check; implicit linking by email at sign-in, or a link
    from a password session without TOTP, is refused (`databaseHooks.account.create.before`).
    Likewise, `GET /api/auth/list-accounts`, `POST /api/auth/unlink-account`, `/delete-user`,
    `/change-password`, `/revoke-sessions`, `/revoke-other-sessions`, `/two-factor/disable` and
    `/two-factor/get-totp-uri` reject an unverified admin password session (`403 TWO_FACTOR_REQUIRED`), `/unlink-account` enforces
    `freshAge <= 15m` and refuses unlinking `credential` passwords (`400 CANNOT_UNLINK_CREDENTIAL`),
    and a password-backed admin with TOTP off cannot remove their last remaining passkey or social
    account (`400 LAST_ADMIN_FACTOR`). A user who signed up with a provider and is later made admin
    keeps that provider.
    Banning deletes the user's sessions and `trusted_device` rows, so the next request answers `401`. The first admin comes
    from `pnpm admin:create` or bootstrap (see deployment.md). The `/admin` page (`apps/admin/`)
    provides an Auth Portal (`#signin`, `#signup`, `#forgot-password`, `#reset-password`, `#verified`)
    with Passkey, Google, GitHub or Apple, and email + password + TOTP (or backup code, with optional 30-day
    device trust), account registration with email verification resend (and `X-Captcha-Response` input when
    `turnstileRequired` is true), password reset requests and token redemption, a signed-in non-admin view
    with password update, a 2FA setup flow for admin password sessions lacking TOTP/passkey, linking/unlinking
    providers and managing passkeys, active sessions, trusted devices, password changes, and live
    Light/Dark/System + primary accent color preferences on Account, inspecting/revoking user sessions on
    Users, and sending pushes and editing templates with the admin session (see api.md, Authentication).
    It is served with a CSP that allows only its own scripts, and renders user data as text.
12. Two-factor (`twoFactor` plugin) covers email + password sign-in with TOTP and backup codes;
    social and passkey sign-ins are not challenged. `POST /api/auth/two-factor/enable { password }` returns the
    TOTP URI (issuer: `APP_NAME`, default `EdgeBase`) and backup codes; 2FA is on once a code is confirmed
    with `verify-totp` (which stamps `user.twoFactorEnabledAt`). A sign-in of a user with 2FA
    answers `{ twoFactorRedirect: true }` with no session and a 10-minute `two_factor` cookie unless
    the caller presents a valid unrevoked D1 `trusted_device` token (cookie `[__Secure-]edgebase_td`
    or header `X-Trust-Device-Token`) from the same country and OS family; on country or OS-family
    shift, 2FA bypass is refused. Every successful `trusted_device` sign-in rotates `token_hash`
    (emitting a fresh cookie and `Set-Trust-Device-Token` while keeping the original 30-day
    `expires_at` ceiling) so a copied token cannot be replayed. `verify-totp` or `verify-backup-code` with that `two_factor`
    cookie creates the session (`twoFactorMethod` set to `totp` or `backup_code`, or `trusted_device`
    when bypassed). Passing `trustDevice: true` during sign-in verification mints a 30-day
    `trusted_device` row (at most 20 per user, listed and revoked at `/v1/trusted-devices`); D1 is
    authoritative, so revoking a row forces 2FA on the next sign-in even if browser cookies remain.
    `change-password`, `reset-password` and `two-factor/disable` wipe the user's `trusted_device`
    rows and other sessions (`change-password` and `reset-password` update `user.passwordChangedAt`;
    `two-factor/disable` clears `user.twoFactorEnabledAt`). `/api/auth/two-factor/*` shares rule 5's
    per-IP limit, and Better Auth locks the challenge after repeated wrong codes.
12a. Passkeys (`@better-auth/passkey` at `/api/auth/passkey/*`): WebAuthn registration and
     authentication enforce `userVerification: "required"`, `rpID = hostname(BASE_URL)`, and
     expected origins from `BASE_URL` and `http(s)://` `TRUSTED_ORIGINS` (plus `http://localhost:5173` in local dev).
     Adding, renaming or deleting a passkey requires a fresh session (`freshAge <= 15m`), caps each
     user at 20 passkeys (`name <= 64` chars), strips `createSession` on registration, and sends an
     email + transactional inbox security alert on registration (sharing the 3/hour alert cap).
13. Organizations (`organization` plugin): a user belongs to at most 10, an organization has at
    most 100 members and 100 pending invitations, and invitations expire after 48 h. Invitations
    are mailed with `<APP_SCHEME>://invitation?id=<id>`; the app accepts with
    `POST /api/auth/organization/accept-invitation`. A trigger deletes an organization when its
    last member row goes, which happens only when that member's account is deleted.
14. `POST /api/auth/update-user { locale }` sets the language pushes are written in; `null`
    clears it, and anything other than a BCP 47 tag such as `es` or `en-US` answers `400`.
