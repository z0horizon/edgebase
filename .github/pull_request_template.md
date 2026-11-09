## What and why

<!-- What changes, and the problem it solves. Link the issue: Closes #123 -->

## How I tested it

<!-- Tests added, or the manual steps you ran. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass
- [ ] Tests cover new logic and any bug fix
- [ ] Docs (`docs/`) updated if behaviour changed
- [ ] `CHANGELOG.md` line under `Unreleased` if users of the template would notice (`Upgrade` line if they must act)
- [ ] New migrations are new files; no applied migration edited
- [ ] New growing tables have a TTL or cap
- [ ] No IDs, URLs, emails, secrets or absolute local paths committed
