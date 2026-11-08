# AGENTS.md — EdgeBase Project Rules

1. **No absolute local paths** in any repository file. Use repository-relative paths.
2. **TypeScript strict**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `any`.
3. **Migrations are append-only**: `packages/core/migrations/` for `DB`, `packages/core/migrations-inbox/` for `INBOX_DB`, numbered `NNNN_<name>.sql`. Never edit a migration that may have been applied.
4. **Column naming**: Better Auth tables keep its camelCase columns; own tables use snake_case; own timestamps are integer epoch milliseconds.
5. **Validate at the boundary**: every client or API-caller input goes through a valibot schema; failure answers `400`.
6. **One error shape**: `{ "error": { "code": string, "message": string } }`.
7. **Fail closed**: a missing `BETTER_AUTH_SECRET` answers `503` on auth routes; a missing `PUSH_API_KEY` or `FCM_SERVICE_ACCOUNT` answers `503` on `/v1/push`. Never open a route because a secret is unset.
8. **Time is a parameter**: functions that depend on the clock take `now: number`, so tests pass it instead of faking time.
9. **Docs follow code**: `docs/design.md`, `docs/api.md` and `docs/specs/*` describe behaviour that exists; change them in the same commit as that behaviour, and add a line under `Unreleased` in `CHANGELOG.md` for anything a user of the template would notice (an `Upgrade` line when they must act).
10. **Storage is bounded**: every table that grows has a TTL or cap: core tables in `packages/core/src/jobs/cleanup.ts`, app tables from `apps/server`'s `scheduled` (see `docs/extending.md`). A new growing table without one is a bug.
11. **No deploy values in git**: account IDs, database IDs, worker URLs, emails and secrets live only in `apps/server/.env.production` (gitignored); `apps/server/wrangler.jsonc` stays a template and `wrangler.production.jsonc` is generated from both.
12. **Core stays generic**: `packages/core` holds EdgeBase itself and `apps/server` only composes it; a feature for one app goes in `apps/server` (see `docs/extending.md`).
