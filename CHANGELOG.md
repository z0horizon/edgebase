# Changelog

What changed for people building on EdgeBase. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). "Upgrade" notes list what you must do by hand.

## [Unreleased]

### Added

- D1 metrics: a tenth of requests, queue batches and socket calls (and every cron run) log `{ "event": "d1", "queries": { "<name>": { calls, rowsRead, rowsWritten, ms } } }` per statement name, so you can see which query costs the most; `sql()` and `registeredQueries()` are exported for naming your own statements (see `docs/extending.md`).

- `GET /v1/realtime`: a WebSocket of events for the signed-in user, so apps react instead of polling. EdgeBase sends `{"type":"inbox"}` when the inbox gains an item (pushes with `inbox: true`, broadcasts, security alerts); apps send their own `{ type, data }` events with `publish()` from `@edgebase/core` or `POST /v1/realtime/publish` (server API key, no FCM needed). Sockets live in 16 hibernating Durable Object hubs (`REALTIME` binding, `RealtimeHub` class), answer `ping` with `pong` without waking them, are checked against their session before events (a session found live is trusted for 30 s; a signed-out or revoked one gets nothing more and is closed), and close on session expiry, after a day, past 10 per user or when the account is deleted (close codes in `docs/api.md`). `requireServerKey` is exported for your own server-to-server routes.
- Realtime rooms, `GET /v1/realtime/rooms/{room}`: members of a chat or shared document send `{ type, data }` messages to each other (relayed with `from`, rate limited to 10 at once then 2 a second, 16 KB each), and the server publishes to a room with `publish(env, { room }, …)` or `POST /v1/realtime/publish`. Off until you call `configureRooms({ canJoin, onMessage? })` in `apps/server/src/index.ts`: `canJoin` decides who joins, `onMessage` stores, rewrites or drops each message. One Durable Object per room (`ROOMS` binding, `RealtimeRoom` class), up to 1,000 sockets; members whose session is gone are closed within a minute; `removeFromRoom` closes a removed member's sockets. Messages are relayed in arrival order; `presence: true` sends `members`, `joined` and `left`; types `error`, `presence` and `inbox` are reserved for EdgeBase. Sockets silent for 3 minutes (no `ping` and no message) are closed as dead, swept also when someone joins and, with presence on, by a room alarm; a room past 200 queued messages answers `busy`, and server events to a room keep the members' order; and a hub past 32,000 sockets answers `503 realtime_full`.
- API calls over `/v1/realtime`: a client sends `{ "type": "request", "data": { id, method, path, body?, idempotencyKey? } }` and gets `{ "type": "response", "data": { id, status, body } }`. Each call runs through the app as that client, with the same session check, validation, rate limit and idempotency as over HTTP, for `/v1` routes other than `/v1/batch` and `/v1/realtime*`; it is billed as 1/20 of a Durable Object request instead of a Worker request. Other text on the personal socket answers `invalid_message`; binary closes it (`4004`). A socket may send 20 messages at once, then 4 a second; at most 10 calls run per socket and 200 per hub (`busy`); a `401` closes the socket only when its session is gone; only Better Auth's cookies are kept for calls.
- `docs/cost.md` has a section on keeping your own code cheap on Cloudflare: requests, CPU, D1, Queues, KV, R2, Durable Objects, logs and billing alerts.
- WebAuthn / FIDO2 Passkeys (`@better-auth/passkey` at `/api/auth/passkey/*`, migration `0009_passkey.sql`): hardware and platform biometric credentials with `userVerification: "required"`, 15-minute `freshAge` step-up on passkey add/rename/delete, a 20-passkey per-user cap (`name <= 64` chars), email + transactional inbox alerts on registration, bootstrap first-passkey enrollment for new admins (blocking plain-password sessions from adding a second passkey), and `passkey` cleanup in `pnpm admin:create --reset-2fa`.
- Session network & activity telemetry: sessions record Cloudflare edge IP (`cf-connecting-ip`), `asn`, `asOrganization`, `country`, `city` at sign-in (`created*`) and on activity (`lastActiveAt`, refreshed in the background every 60 minutes or on ASN/country shift, capped at 30 active sessions per user), plus `twoFactorMethod` and `twoFactorVerifiedAt`, inspected and revoked via `GET /v1/sessions`, `DELETE /v1/sessions/{id}`, `POST /v1/sessions/revoke-others`, and admin `GET / DELETE /v1/admin/users/{userId}/sessions[/{sessionId}]` without exposing raw session tokens (`/api/auth/list-sessions` and `/api/auth/admin/list-user-sessions` now answer `404`).
- Account security timestamps (`twoFactorEnabledAt`, `passwordChangedAt`) on `user` and `GET /v1/me`, a 15-minute `freshAge` step-up window on passwordless sensitive actions, and email + transactional inbox alerts (capped at 3/hour per user) when an established user signs in from a new `(asn, country)` network.
- D1-backed 30-day 2FA trusted devices (`trusted_device`, capped at 20 per user and cleaned up hourly) supporting both web cookies and native `Set-Trust-Device-Token` / `X-Trust-Device-Token` headers, single-use token rotation on every sign-in (without extending the 30-day expiry), adaptive country and OS-family anomaly rejection, managed via `GET / DELETE /v1/trusted-devices` and `DELETE /v1/trusted-devices/{id}`, and wiped automatically on password change/reset, 2FA disable, or ban.
- Boundary & anti-bloat hardening: 64 KB global request body cap (`413 payload_too_large`), `Origin` CSRF validation on cookie-authenticated `/v1/*` mutations (`403 forbidden_origin`), length caps on `user` and `organization` fields, and a unique index on `twoFactor(userId)`.
- Social OAuth multi-platform, unlinking & factor hardening: `GOOGLE_CLIENT_ID` accepts comma-separated client IDs (web ID first, plus optional iOS/Android IDs for native `idToken` audience verification); `GET /api/auth/list-accounts`, `POST /api/auth/unlink-account`, `/delete-user`, `/change-password`, `/revoke-sessions`, `/revoke-other-sessions`, `/two-factor/disable`, `/two-factor/get-totp-uri` reject unverified admin password sessions (`403 TWO_FACTOR_REQUIRED`), and `POST /api/auth/two-factor/enable` plus bootstrap passkey registration reject unverified admin password sessions once any passkey or social provider exists (`403 TWO_FACTOR_REQUIRED`); `/unlink-account` enforces 15-minute `freshAge`, refuses unlinking `credential` passwords (`400 CANNOT_UNLINK_CREDENTIAL`), and prevents password-backed admins with TOTP off from removing their last second factor (`400 LAST_ADMIN_FACTOR`); `/api/auth/get-access-token`, `/api/auth/refresh-token` and `/api/auth/account-info` answer `404`; `/api/auth/link-social` and `/api/auth/unlink-account` share `AUTH_RL`; `/admin/` Account & Security adds provider unlinking and preserves `#account` across OAuth redirects.
- Admin console (`/admin/`) & `GET /v1/auth/providers`: redesigned interface (`AuthShell` centered authentication workspace and Tailscale-inspired unified tonal console rail with `1px` hairline ledger tables across **Users**, **Sent pushes**, **Templates**, and **Account & Security**, live notification + payload `<dl>` inspector on **Send push**, live `System` / `Light` / `Dark` theme switching and customizable primary accent color defaulting to Ocean Blue `#0369A1` / `#0EA5E9`), added account registration (`#signup` + verification resend + optional Turnstile token input backed by `turnstileRequired` on `/v1/auth/providers`), forgot/reset password (`#forgot-password`, `#reset-password`), email verification confirmation (`#verified`), signed-in non-admin access screen with password change, zero-dependency Passkey sign-in, bootstrap enrollment and management, backup code and 30-day device trust options at 2FA sign-in, active session and trusted-device management, per-user session telemetry & revocation, and split vendor chunks.
- `EMAIL_PASSWORD=off` (default `on`) turns email and password sign-in, sign-up, password reset and verification mail off (`404`) for apps that sign in only with Google, Apple, GitHub or passkeys; `GET /v1/auth/providers` adds `emailPassword`, and `pnpm admin:create` then promotes an account that can sign in with a provider or passkey (and signs it out everywhere) instead of setting a password.
- Per-user rate limits on signed-in `/v1` routes (except `/v1/admin/*`, and not for admins): 120 calls and 60 writing calls a minute (`USER_RL`, `USER_WRITE_RL`), over which they answer `429 rate_limited`; every `429 rate_limited`, including the sign-in and topic limits, now carries `Retry-After: 60`, so one account calling in a loop cannot run up Worker requests or D1 writes.
- `EMAIL_RL`: sign-in, sign-up, password reset and resend verification allow 5 attempts a minute per email address from any IP (`429 rate_limited`).
- `POST /v1/batch`: up to 10 calls to `/v1/*` routes, your own included, in one request; each runs as the caller with the same checks and per-user limit as a direct call. With an `Idempotency-Key` header the answer is replayed for 24 h instead of running the batch again.
- `POST /v1/sync`: one request for an app start that registers the device token, reports opened pushes (up to 20), marks inbox items read and returns the user and the first inbox page, replacing three to five separate calls.
- `userRateLimit` is exported from `@edgebase/core`, so your own signed-in routes can share the per-user limit (see `docs/extending.md`); they have none until you add it.
- `EMAIL_SENDING=off` (default `on`, needs `EMAIL_PASSWORD=off`): sends no mail and deploys without the mail binding, so Email Sending and `MAIL_FROM` are not needed; security alerts reach only the in-app inbox and organization invitations are not mailed.
- `SESSION_REFRESH_DAYS` (1 to 14, default 1): how often an active session's 30-day expiry is pushed forward; a higher number saves D1 writes, and an unused session may then expire up to that many days early.
- `SESSION_ACTIVITY=off` (default `on`) stops the background write of a session's `lastActiveAt` and current network.
- `CUSTOM_DOMAIN` in `.env.production` (optional): deploy then serves the Worker on that hostname and turns its `workers.dev` and preview URLs off, so a zone's WAF and rate limiting rules see every request; `BASE_URL` must be `https://<CUSTOM_DOMAIN>`. `docs/deployment.md` describes the WAF rules and spend limit to pair with it.
- `APP_NAME` (default `EdgeBase`; `pnpm bootstrap` sets it to `PROJECT_NAME` when empty) names the product to people: mail subjects start with `<APP_NAME>: `, it is the TOTP issuer and passkey relying-party name (both were `EdgeBase` / the `BASE_URL` host), the admin page's sidebar, sign-in subtitle, push preview and tab title use it, and `GET /v1/auth/providers` returns it as `appName`.

### Changed

- Personal inbox items are stored in one table per week (`inbox_item_w<n>`, made by code) and expire by dropping a whole week, which writes no D1 rows: expiring items used to cost as many writes as storing them. Item ids keep the `p_<number>` form (larger numbers, which name the week). Items expire up to 7 days after `INBOX_TTL_DAYS` (reads still hide them at the TTL). Items stored before stay in `inbox_item`, are still read, and expire as before. The zero-write drop was measured on local D1; check `rowsWritten` in the `d1` log line of `cron:cleanup` on yours. `INBOX_TTL_DAYS` is now capped at 90 (a read names one table per week of it); deploys refuse more, and a larger runtime value falls back to 30.
- `SESSION_REFRESH_DAYS` defaults to 3 (was 1), and with `SESSION_ACTIVITY=on` a session's `lastActiveAt` and network are written at most daily (was every 6 hours) and every 6 hours on a new ASN (was hourly); a new country is still written at once. Together with the inbox change, about half the D1 row writes of the 1M-user estimate in `docs/cost.md`. A session's stored network can now lag up to 6 hours behind on a phone hopping between carriers, so sign-in alerts for a "new network" may fire a little more often, and a session's "last active" may lag up to a day.
- Every signed-in request ran about 20 schema-introspection statements (Better Auth's runtime schema check, repeated because an auth instance lives one request) and two statements for the session and its user; it now runs one, a join. `GET /v1/me` went from 23 statements to 1, and every other signed-in call saves the same. The schema check runs in the test suite instead.
- `POST /v1/sync` marks items read and reads the inbox in one batch, beside the device and open writes, instead of one after the other.
- Core's SQL moved into named `queries.ts` modules; a test checks every statement's query plan for full table scans. If you edited core SQL in place, expect merge conflicts there.

### Fixed

- `/v1/sessions` and `/v1/trusted-devices` checked the session and counted the per-user rate limit twice per call (their middleware was registered for both `/x` and `/x/*`), so these routes allowed about half the documented 120 calls a minute.
- Admin page requests: an action on Account & Security reloads only the list it changed (one call instead of four), the Templates and Send pages share one template list, and `GET /v1/auth/providers` is cached by browsers for 10 seconds.
- Session activity writes: an active session's `lastActiveAt` and network are written at once only on a new country, at most hourly on a new ASN (was every hop between Wi-Fi and mobile data) and otherwise every 6 hours (was hourly). `docs/cost.md` now counts logs, storage and sign-in writes.
- Cloudflare cost, security & runtime optimizations: `AUTH_RL` now normalizes native IPv6 addresses to `/64` without collapsing IPv4-mapped addresses; `/api/auth/admin/*` and security-guarded auth routes read `session` + `user` once per request instead of twice; `GET /v1/push` and `GET /v1/push/{id}` read a pre-aggregated `push_stats.opened` counter (migration `0010_push_stats_opened.sql`) instead of scanning `push_open`; `GET /v1/inbox` runs in one `INBOX_DB` batch; `runCleanup` bounds `byRowid` searches to `O(M)` linear `rows_read` on large backlogs; immediate pushes skip redundant `scheduled_push` claim writes while fresh; the push consumer batches up to 5 messages (`max_batch_size: 5`, `max_batch_timeout: 1`), coalesces `push_stats` writes, and cancels unread FCM/IID `fetch` response bodies; `wrangler.jsonc` enables `upload_source_maps`, `prod-config.mjs` locks `MAIL` `send_email` to `allowed_sender_addresses: [MAIL_FROM]`, `public/_headers` caches `/admin/assets/*` as `immutable`, and Worker logs emit flat structured JSON objects.

### Upgrade

- If your own code reads `inbox_item` directly, new personal items are no longer there: they are in the week tables `inbox_item_w<n>`; go through `listInbox` / `listInboxWithUnread` from `packages/core/src/inbox/queries.ts`, or list the tables with `existingBucketTables`. An `INBOX_TTL_DAYS` above 90 must be lowered before deploying.
- Sessions are now extended every 3 days by default: a session left unused for 27 to 30 days may already have expired. Set `SESSION_REFRESH_DAYS=1` in `.env.production` to keep the old behaviour.
- `pnpm run deploy` and `pnpm bootstrap` now refuse a deployment with email and password sign-in on and no `TURNSTILE_SECRET_KEY`: create a Turnstile widget (free), set its secret, and have your apps send `X-Captcha-Response` on sign-up, password reset and resend verification; or set `EMAIL_PASSWORD=off`.
- Before setting `EMAIL_PASSWORD=off` on a deployment whose admins sign in with a password, have each of them link Google, Apple or GitHub, or add a passkey, under Account & Security while it is still on. Afterwards their password no longer works, and a provider cannot join an existing admin by email.
- Clients that call signed-in `/v1` routes more than 120 times (or write more than 60 times) a minute per user now get `429 rate_limited`; make them wait for `Retry-After`. The two new rate-limit bindings come from `wrangler.jsonc` on the next deploy.
- Set `APP_NAME` in `.env.production` to the name your users should see before the next `pnpm bootstrap`, which otherwise fills it with `PROJECT_NAME` (a deploy without bootstrap keeps `EdgeBase`). Mail subjects gain the `<APP_NAME>: ` prefix, and new TOTP enrollments show it instead of the `BASE_URL` host; existing authenticator entries and passkeys keep their label.
- Realtime needs the Durable Object in your Worker: merge the `durable_objects` and `migrations` blocks of the template's `apps/server/wrangler.jsonc` into yours (both tags, in order) and add `export { RealtimeHub, RealtimeRoom } from "@edgebase/core";` to `apps/server/src/index.ts`, then `pnpm types` and deploy. Apps that keep polling still work; switch them to `/v1/realtime`, reading the API (`POST /v1/sync`) on every (re)connect.
- Apply migrations `0008_session_security_and_trusted_device.sql`, `0009_passkey.sql`, and `0010_push_stats_opened.sql` (`pnpm db:migrate:remote`).

## [0.3.0] - 2026-11-14

### Added

- `GET /v1/me` also answers `adminNeedsTwoFactor`, so a client gates admin features on the server's rule; the admin page uses it.
- Pushing a `vX.Y.Z` tag publishes a GitHub release from its CHANGELOG section after CI passes.
- The admin page signs in with Google, GitHub or Apple. Those sessions reach admin features without the account's TOTP; email + password sessions still need it. An existing admin links a provider from the page's Account view; signing in with an unlinked provider account of an admin's email is refused.

### Fixed

- `pnpm admin:create --remote` rewrote `.env.production` in sorted key order; it now keeps the example's order like `pnpm bootstrap`.
- Inbox reads no longer scan every broadcast: each `GET /v1/inbox` and `unread-count` read the whole `broadcast` table, which spent D1 rows read in proportion to broadcasts kept. `unread-count` takes one D1 round trip instead of two.
- An immediate `POST /v1/push` that failed after writing the inbox answered `500` and freed its Idempotency-Key, so the client's retry wrote the inbox again and left an extra stats row. It now answers `202 { id, scheduled: true }` and the minute cron finishes the send.
- `POST /v1/push` stores its stats row and its push in one transaction, so a failure between them no longer leaves an empty stats row.
- The admin page shows only the sign-in providers whose credentials are set (new `GET /v1/auth/providers`); a button for a provider that is off used to fail when clicked.
- Scheduled pushes are claimed before they are sent, so overlapping cron runs never send one twice, and a push that keeps failing no longer holds back the ones behind it.
- `/v1/auth/app-callback` binds the PKCE `challenge` to the OAuth callback that created the session and allows one hand-off per session, so another app claiming `APP_SCHEME` cannot mint a token from a shared browser session.
- `POST /api/auth/reset-password`, `/change-password`, `/verify-password` and `/delete-user` now share the per-IP auth rate limit (`429 rate_limited`).
- Marketing push delivery and per-token retries re-check `marketingOptIn`, and template placeholder filling checks own properties only.
- Hourly cleanup skips remaining tables once its 20 s budget runs out, deletes inbox and push-open rows of expired unverified users, and prunes `scheduled_push` rows stuck more than 24 h past their send time.
- `pnpm admin:create` passes D1 statements through a `0600` temporary `--file` instead of `--command` CLI arguments, and `/admin` clears queued recipient drafts on sign-out.

### Upgrade

- Apply migrations `0003_broadcast_created_at.sql` and `0004_inbox_push.sql` (inbox) and `0007_session_sign_in_provider.sql` (`pnpm db:migrate:remote`). Admins already signed in with a provider sign in again; until then their session counts as a password one.

## [0.2.0] - 2026-11-09

### Changed

- The repository is a pnpm workspace:
  - `packages/core` is EdgeBase.
  - `apps/server` is your Worker: `wrangler.jsonc`, `src/index.ts`, scripts and `.env.production`.
  - `apps/admin` is the admin page.
  
  Root commands (`pnpm dev`, `pnpm bootstrap`, `pnpm run deploy`, `pnpm db:migrate:*`) work as before.
- Bootstrap, deploy and migrations read the D1 databases from `apps/server/wrangler.jsonc`. A database you add there is created, migrated and deployed with no script changes, and its id is stored as `<binding>_ID`.
- Redesigned `/admin/` with a user search-and-select recipient picker, multi-user selection from the Users table, push summary stats, and template placeholder highlighting.
- Requires pnpm 10 or later.
- Releases are `vX.Y.Z` tags; [Updating EdgeBase](docs/extending.md#updating-edgebase) merges a tag instead of `main`.

### Added

- `@edgebase/core` exports `app`, `worker`, `requireUser`, `requireAuthConfig`, `requireApiKey`, `jsonError` and `parseBody` for your own routes. See [docs/extending.md](docs/extending.md).
- `pnpm admin:create [--remote]` and `pnpm bootstrap` create the first admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in a gitignored file, without mail; an empty password is generated.
- `pnpm admin:dev` starts the Worker and the admin page together.
- `pnpm admin:create` and `pnpm bootstrap` create `apps/server/.dev.vars` or fill its empty secrets, never replacing a value; no manual copy of `.dev.vars.example` is needed.
- Admin features need two-factor: an admin without TOTP gets `403 two_factor_required` on `/api/auth/admin/*` and the admin-session push routes, and the admin page walks them through setting it up. `pnpm admin:create --reset-2fa` resets an admin who lost their authenticator.
- MIT license.
- [docs/cost.md](docs/cost.md) counts what an active user costs (API calls, session and device refreshes, reported opens), lists client rules that keep cost down, and gives a full monthly estimate for 1M daily users. It also states what runs on Workers Free and for about how many users.

### Upgrade

- Move `.env.production`, `.dev.vars` and `.wrangler/` from the repository root into `apps/server/`. `pnpm bootstrap` refuses to run until you do.
- A relative `FCM_SERVICE_ACCOUNT_FILE` now resolves from `apps/server/`.
- Existing admins set up two-factor at their next sign-in to the admin page; API-key callers of `/v1/push` are unaffected.
- Routes you added to `src/app.ts` move to `apps/server/src/index.ts`.

## [0.1.0] - 2026-11-08

First version.

### Added

- **Auth** (Better Auth, sessions in D1 and revoked on the next request):
  - sign-in with email and password, Google, Apple and GitHub;
  - bearer tokens and a one-time-token exchange for native apps;
  - optional Cloudflare Turnstile on sign-up, password reset and verification mail;
  - admin roles and bans, TOTP two-factor with backup codes, and organizations.
- **Push** (FCM HTTP v1):
  - device registration, capped at 10 per user;
  - sending to users or topics, now or scheduled, through a queue with per-token retry and a dead-letter queue;
  - an `Idempotency-Key` on `POST /v1/push`;
  - delivery and open statistics;
  - templates with placeholders and per-locale translations;
  - transactional and marketing categories (marketing only to users who opted in);
  - web topic subscription.
- **Inbox:** personal items and broadcasts in one list, with cursor paging, a read watermark and `unreadCount`.
- **Admin page** at `/admin/`: users (role, ban), sending a push with a preview, sent pushes with their open rate, and templates.
- **Retention:** an hourly cleanup with a TTL or a cap for every growing table.
- **Operations:**
  - `pnpm bootstrap` creates the databases and queues and uploads the secrets, keeping every deploy value in a gitignored `.env.production`;
  - 10% log sampling;
  - per-IP rate limits on auth and per-user limits on topic changes.

[Unreleased]: https://github.com/z0horizon/edgebase/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/z0horizon/edgebase/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/z0horizon/edgebase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/z0horizon/edgebase/releases/tag/v0.1.0
