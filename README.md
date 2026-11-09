# EdgeBase

A backend template on Cloudflare Workers: sign-in with Better Auth (email and password, Google,
Apple, GitHub) and push notifications through Firebase Cloud Messaging with an in-app inbox.
Clone it, bootstrap it, deploy it, build on it.

## Quick start

Requirements: Node.js 22+, pnpm 10+, Wrangler logged in (`npx wrangler login`), Workers Paid plan
(Free works with limits, see [Cost](#cost)).

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm db:migrate:local
pnpm admin:create       # local secrets in apps/server/.dev.vars, and an admin whose password
                        # is saved in apps/server/.env.local
pnpm admin:dev          # Worker and admin page: http://localhost:5173/admin/
```

## Start a new project from this template

1. Clone the latest release: `git clone --branch vX.Y.Z https://github.com/z0horizon/edgebase.git`
   (clone or fork, not "Use this template", so updates merge; see
   [Updating EdgeBase](docs/extending.md#updating-edgebase)).
2. `pnpm bootstrap` asks for a project name (lowercase, dashes, e.g. `acme`) and the deploy
   values, creates the D1 databases and queues under that name, migrates them and uploads the
   secrets. Everything it learns goes to `apps/server/.env.production`, which is gitignored, so the
   code never needs renaming and no ID or secret is committed.
3. `pnpm run deploy`.
4. Build your features in `apps/server` and leave `packages/core` to EdgeBase, so updates merge
   cleanly (see [docs/extending.md](docs/extending.md)).

See [docs/deployment.md](docs/deployment.md) for details.

## Cost

The Workers Free plan runs EdgeBase for development and for small apps of up to about 10k daily
users that sign in with Google, Apple or GitHub only; email and password sign-in and mail need
Workers Paid. Apps of moderate size fit in the $5 Paid plan. At 1M daily users expect roughly $260 a month, mostly
Worker requests from client API calls and D1 row writes from inbox items and daily session
refreshes. How often your client calls the API matters most; see
[docs/cost.md](docs/cost.md) for the numbers and the client rules that keep them down.

## Docs

- [docs/design.md](docs/design.md): architecture and why
- [docs/api.md](docs/api.md): HTTP API
- [docs/extending.md](docs/extending.md): your own routes and tables
- [docs/specs/](docs/specs/README.md): behaviour per domain
- [docs/deployment.md](docs/deployment.md), [docs/cost.md](docs/cost.md), [docs/roadmap.md](docs/roadmap.md)
- [CHANGELOG.md](CHANGELOG.md): what changed, and what to do when you update

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
