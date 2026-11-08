# EdgeBase

A backend template on Cloudflare Workers: sign-in with Better Auth (email and password, Google,
Apple, GitHub) and push notifications through Firebase Cloud Messaging with an in-app inbox.
Clone it, rename it, deploy it, build on it.

## Quick start

Requirements: Node.js 22+, pnpm, Wrangler logged in (`npx wrangler login`), Workers Paid plan.

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
cp .dev.vars.example .dev.vars   # fill in secrets
pnpm db:migrate:local
pnpm dev
```

## Start a new project from this template

1. Copy the repository and pick a name (lowercase, dashes), e.g. `acme`.
2. Replace every `edgebase` (worker name, both D1 names, both queue names, `APP_SCHEME`, package name):

   ```bash
   grep -rl edgebase --exclude-dir=node_modules --exclude-dir=.git . | xargs sed -i '' 's/edgebase/acme/g'
   ```

   (On Linux use `sed -i` without `''`.)
3. Follow [docs/deployment.md](docs/deployment.md): create the resources, paste the new
   `database_id`s into `wrangler.jsonc`, set secrets, migrate, deploy.
4. Build your features: add routes in `src/app.ts`, keep docs in `docs/specs/` true to the code
   (see `AGENTS.md`).

## Docs

- [docs/design.md](docs/design.md): architecture and why
- [docs/api.md](docs/api.md): HTTP API
- [docs/specs/](docs/specs/README.md): behaviour per domain
- [docs/deployment.md](docs/deployment.md), [docs/cost.md](docs/cost.md), [docs/roadmap.md](docs/roadmap.md)
