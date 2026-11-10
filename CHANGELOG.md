# Changelog

What changed for people building on EdgeBase. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). "Upgrade" notes list what you must do by hand.

## [Unreleased]

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

[Unreleased]: https://github.com/z0horizon/edgebase/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/z0horizon/edgebase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/z0horizon/edgebase/releases/tag/v0.1.0
