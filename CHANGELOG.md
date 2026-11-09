# Changelog

What changed for people building on EdgeBase. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). "Upgrade" notes list what you must do by hand.

## [Unreleased]

### Changed

- The repository is a pnpm workspace:
  - `packages/core` is EdgeBase.
  - `apps/server` is your Worker: `wrangler.jsonc`, `src/index.ts`, scripts and `.env.production`.
  - `apps/admin` is the admin page.
  
  Root commands (`pnpm dev`, `pnpm bootstrap`, `pnpm run deploy`, `pnpm db:migrate:*`) work as before.
- Bootstrap, deploy and migrations read the D1 databases from `apps/server/wrangler.jsonc`. A database you add there is created, migrated and deployed with no script changes, and its id is stored as `<binding>_ID`.
- Redesigned `/admin/` with a user search-and-select recipient picker, multi-user selection from the Users table, push summary stats, and template placeholder highlighting.
- Requires pnpm 10 or later.

### Added

- `@edgebase/core` exports `app`, `worker`, `requireUser`, `requireAuthConfig`, `requireApiKey`, `jsonError` and `parseBody` for your own routes. See [docs/extending.md](docs/extending.md).
- `pnpm admin:create [--remote]` and `pnpm bootstrap` create the first admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in a gitignored file, without mail; an empty password is generated.
- `pnpm admin:dev` starts the Worker and the admin page together.
- `pnpm admin:create` and `pnpm bootstrap` create `apps/server/.dev.vars` or fill its empty secrets, never replacing a value; no manual copy of `.dev.vars.example` is needed.
- Admin features need two-factor: an admin without TOTP gets `403 two_factor_required` on `/api/auth/admin/*` and the admin-session push routes, and the admin page walks them through setting it up. `pnpm admin:create --reset-2fa` resets an admin who lost their authenticator.
- MIT license.

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

[Unreleased]: https://github.com/z0horizon/edgebase/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/z0horizon/edgebase/releases/tag/v0.1.0
