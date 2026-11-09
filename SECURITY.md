# Security Policy

## Supported versions

Only the latest release (the newest `vX.Y.Z` tag) and `main` get security fixes. To get a fix,
merge it into your copy as described in
[Updating EdgeBase](docs/extending.md#updating-edgebase), and follow the `Upgrade` steps in
[CHANGELOG.md](CHANGELOG.md).

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security problem.

Report it privately through
[GitHub private vulnerability reporting](https://github.com/z0horizon/edgebase/security/advisories/new).
Include:

- what is affected (route, script, file) and the commit you tested,
- steps or a request that reproduces it,
- the impact you expect (what an attacker gains).

What to expect:

- an acknowledgement within 3 business days,
- an assessment and a plan within 10 business days,
- a fix on `main` and a GitHub security advisory, crediting you unless you ask otherwise.

Please give us a reasonable time to ship a fix before you disclose the issue publicly.

## Scope

In scope: code in this repository, mainly `packages/core` (auth, sessions, two-factor, admin
routes, push, inbox, cleanup jobs), `apps/server` scripts and `apps/admin`.

Out of scope:

- Vulnerabilities in Cloudflare, Better Auth, Firebase or other dependencies; report those
  upstream (we still want to hear if EdgeBase uses them unsafely).
- Problems in a deployment caused by its own configuration or code built on top of EdgeBase.
- Denial of service by traffic volume, and missing hardening with no concrete exploit.

## Security model, in short

- Auth routes answer `503` when `BETTER_AUTH_SECRET` is missing; `/v1/push` answers `503` when
  `PUSH_API_KEY` or `FCM_SERVICE_ACCOUNT` is missing. Routes never open because a secret is unset.
- Admin features require two-factor authentication.
- Every client input is validated at the boundary; invalid input answers `400`.
- Deploy values and secrets live only in gitignored files (`apps/server/.env.production`,
  `apps/server/.dev.vars`, `apps/server/.env.local`) and Wrangler secrets, never in git.

See [docs/design.md](docs/design.md) for details.
