# Adding your own backend

EdgeBase is a pnpm workspace. Your code lives in `apps/server`; EdgeBase itself lives in
`packages/core`, and you leave it alone so its updates merge without touching your work.

| Path | Holds | Yours to edit |
|---|---|---|
| `packages/core` | auth, push, inbox, jobs, their migrations and tests | no |
| `apps/server` | the Worker: `wrangler.jsonc`, `src/index.ts`, deploy scripts, `.env.production` | yes |
| `apps/admin` | the `/admin` page (React + shadcn/ui), built into `apps/server/public/admin` | if you like |

## Routes

Add routes to the core `app` in `apps/server/src/index.ts`, before the export. They get the same
CORS, error shape and `404`/`500` handling as EdgeBase's own routes. Your middleware, even
`app.use("*", …)`, runs only for your routes: EdgeBase's routes are registered first and answer
without passing on, so you cannot wrap or replace them from here.

```ts
// apps/server/src/orders.ts
import type { AppEnv } from "@edgebase/core";
import { Hono } from "hono";

export const orders = new Hono<AppEnv>().get("/", (c) => c.json({ userId: c.get("user").id }));
```

```ts
// apps/server/src/index.ts
import { app, requireAuthConfig, requireUser, worker } from "@edgebase/core";
import { orders } from "./orders";

app.use("/v1/orders/*", requireAuthConfig, requireUser); // a signed-in user, as c.get("user")
app.route("/v1/orders", orders);

export default worker;
```

- `requireAuthConfig, requireUser`: a Better Auth session (cookie or bearer); `401` otherwise.
- `requireApiKey`: your servers, with `X-API-Key: <PUSH_API_KEY>`, or an admin's session.
- `parseBody(c, schema)`: a valibot-checked JSON body, or the `400` response to return.
- `jsonError(status, code, message)`: the one error shape.

Keep away from the paths EdgeBase owns: `/api/auth/*`, `/v1/auth/*`, `/v1/me`, `/v1/devices`,
`/v1/inbox`, `/v1/opens`, `/v1/topics`, `/v1/push`, `/v1/templates`, `/health` and `/admin/`.

## Your own tables

Give them their own D1 database, so EdgeBase's migrations and yours never share a numbering:

1. Add it to `apps/server/wrangler.jsonc`, named after the template so deploys can rename it:
   ```jsonc
   { "binding": "APP_DB", "database_name": "edgebase-app", "database_id": "local-app",
     "migrations_dir": "migrations" }
   ```
2. Put migrations in `apps/server/migrations/` (`0001_<name>.sql`, append-only), then `pnpm types`
   to add the binding to `Env`.
3. `pnpm db:migrate:local` migrates every database in `wrangler.jsonc`. `pnpm bootstrap` creates
   `<PROJECT_NAME>-app` in Cloudflare, stores its id as `APP_DB_ID` in `.env.production` and
   migrates it; `pnpm run deploy` and `pnpm db:migrate:remote` pick it up from there.

Your own dependencies go into `apps/server`, for example `pnpm --filter @edgebase/server add zod`.
`hono` and `valibot` are there already, at the same versions as core; keep them equal, or Hono's
types from the two copies stop matching.

## Tests

Core's tests are in `packages/core/test` and run on `pnpm test`. To test your routes, copy
`packages/core/vitest.config.ts` into `apps/server` (with `configPath: "./wrangler.jsonc"` and your
migrations), add `vitest` and `@cloudflare/vitest-plugin` to `apps/server`'s devDependencies, and
call `app.request(...)` the way `packages/core/test/helpers.ts` does.

Every table that grows needs a TTL or a cap. Run your cleanup from `scheduled`:

```ts
export default {
  ...worker,
  async scheduled(controller, env, ctx) {
    await worker.scheduled(controller, env, ctx);
    if (controller.cron === "17 * * * *") ctx.waitUntil(cleanUpOrders(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
```

## Updating EdgeBase

Start from a clone or fork, not GitHub's "Use this template": a template copy has no shared
history, so every later merge conflicts on every file. Releases are `vX.Y.Z` tags, each with its
section in [CHANGELOG.md](../CHANGELOG.md); merge a tag rather than `main`, which may hold
unreleased work. Watch the repository for releases to hear about new ones. Then:

```bash
git remote add upstream https://github.com/z0horizon/edgebase.git   # once
git fetch upstream --tags && git merge v0.2.0     # the release you want; read its Upgrade steps
pnpm install                                         # regenerates pnpm-lock.yaml if it conflicted
pnpm db:migrate:local && pnpm typecheck && pnpm test
```

Most updates touch only `packages/core` and `apps/admin`. These shared files can also change, and
conflict where you have edited them: `apps/server/wrangler.jsonc` (a new binding or cron),
`apps/server/src/index.ts`, `apps/server/scripts/*`, `apps/server/package.json`, the root
`package.json` and `pnpm-lock.yaml`. `pnpm run deploy` does not migrate: run
`pnpm db:migrate:remote` first when an update adds a migration.

### From the single-package layout

Before the workspace, `.env.production`, `.dev.vars` and `.wrangler/` (local D1 data) sat at the
repository root. Move them into `apps/server/` before anything else; `pnpm bootstrap` refuses to
run while they are still at the root, since starting over would generate new secrets.
