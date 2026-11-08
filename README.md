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
