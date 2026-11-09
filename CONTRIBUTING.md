# Contributing to EdgeBase

Thanks for helping. EdgeBase is a backend template on Cloudflare Workers; changes should keep it
small, generic and cheap to run.

Security problems: do not open an issue, follow [SECURITY.md](SECURITY.md).

## Before you start

- Bugs: open an issue with steps to reproduce, what you expected and what happened.
- Features: open an issue first so we can agree on scope. `packages/core` holds only what most
  apps need; a feature for one app belongs in your own `apps/server` (see
  [docs/extending.md](docs/extending.md)). Check [docs/roadmap.md](docs/roadmap.md) too.

## Set up

Requirements: Node.js 22+, pnpm 10+.

```bash
pnpm install
pnpm db:migrate:local
pnpm admin:create       # local secrets and a first admin
pnpm admin:dev          # Worker and admin page: http://localhost:5173/admin/
```

Layout: `packages/core` is EdgeBase, `apps/server` composes it into a Worker, `apps/admin` is the
admin page.

## Make a change

1. Branch from `main`.
2. Follow the project rules in [AGENTS.md](AGENTS.md). The ones most often missed:
   - TypeScript strict, no `any`.
   - Validate every client input with a valibot schema; failures answer `400` with the shared
     error shape `{ "error": { "code", "message" } }`.
   - Migrations are append-only: add a new `NNNN_<name>.sql`, never edit an existing one.
   - Every growing table has a TTL or cap.
   - Functions that depend on the clock take `now: number`.
   - No account IDs, database IDs, worker URLs, emails or secrets in any committed file, and no
     absolute local paths.
3. Add tests for logic that can break (branches, parsers, auth, data writes) and for every bug
   fix; a test should fail without your change.
4. Update `docs/` in the same change when behaviour changes, and add a line under `Unreleased` in
   [CHANGELOG.md](CHANGELOG.md) for anything a user of the template would notice (an `Upgrade`
   line when they must act).
5. Run the same checks as CI:

   ```bash
   pnpm typecheck && pnpm lint && pnpm test
   ```

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(auth): ...`, `fix(push): ...`, `docs(cost): ...`.
- One topic per pull request. Describe what changed, why, and how you tested it.
- CI must pass before review.

## Releasing (maintainers)

When `Unreleased` in [CHANGELOG.md](CHANGELOG.md) holds something users should get:

1. Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add an empty `## [Unreleased]` above it,
   and update the compare links at the bottom. Before 1.0, bump the minor version for anything
   with an `Upgrade` line and the patch version for fixes only.
2. Commit as `chore(release): vX.Y.Z`, then `git tag -a vX.Y.Z -m vX.Y.Z && git push --follow-tags`.
3. Create a GitHub release from the tag with that version's CHANGELOG section, so watchers are
   notified.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
