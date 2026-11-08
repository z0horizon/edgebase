# Deployment

Requirements: a Cloudflare account on the **Workers Paid** plan (password hashing needs more CPU
than the free plan allows, and Email Sending needs Paid), Node.js 22+, pnpm, and
`npx wrangler login`.

## 1. Bootstrap

```bash
pnpm bootstrap          # add --yes to never prompt (CI); it then fails on any missing value
```

It asks for what `.env.production` lacks, then:

1. checks the Wrangler login, and picks the account (`CLOUDFLARE_ACCOUNT_ID`) when there are several;
2. generates `BETTER_AUTH_SECRET` and `PUSH_API_KEY` when empty;
3. finds or creates the D1 databases `<PROJECT_NAME>-db` and `<PROJECT_NAME>-inbox` and stores
   their IDs;
4. creates the queues `<PROJECT_NAME>-push` and `<PROJECT_NAME>-push-dlq` when missing;
5. writes `wrangler.production.jsonc` and applies the remote migrations;
6. uploads every secret with `wrangler secret bulk` (a draft Worker is created if none exists yet);
7. creates `.dev.vars` for local dev when it does not exist.

Rerun it any time: each step skips what already exists. Every key of `.env.production` is
explained in [`.env.production.example`](../.env.production.example).

`.env.production` is the source of truth for secrets: a secret that is empty there is deleted from
the Worker on the next bootstrap, including one set by hand with `wrangler secret put`.

## 2. Sign-in providers and push

Fill in the optional keys of `.env.production`, then `pnpm bootstrap` again:

| Keys | Where to get them |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud console, OAuth client (web) |
| `APPLE_CLIENT_ID`, `APPLE_APP_BUNDLE_IDENTIFIER` | Apple Developer: Services ID and the app's bundle ID |
| `APPLE_CLIENT_SECRET` | `node scripts/apple-secret.mjs <teamId> <keyId> <servicesId> AuthKey.p8` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `TURNSTILE_SECRET_KEY` | Cloudflare dashboard → Turnstile → add a widget (free); its secret key. Turn it on when sign-up or reset emails are abused; the apps must then send the widget's token (see [api.md](api.md#authentication)) |
| `FCM_SERVICE_ACCOUNT_FILE` | Firebase console → Service accounts → generate key; the path to the JSON file |

OAuth redirect URIs: `<BASE_URL>/api/auth/callback/<google|apple|github>`. A provider whose ID or
secret is unset is simply off, so you can deploy with email sign-in only and add providers later.

Missing `BETTER_AUTH_SECRET` makes all auth routes answer `503`; missing `PUSH_API_KEY` or
`FCM_SERVICE_ACCOUNT` does the same for `/v1/push`. Give `PUSH_API_KEY` to your servers.

## 3. Deploy

```bash
pnpm run deploy               # regenerates wrangler.production.jsonc, then wrangler deploy
pnpm db:migrate:remote        # after pulling new migrations
```

Both regenerate `wrangler.production.jsonc` from `wrangler.jsonc` and `.env.production` first, so
template changes (bindings, crons) always reach production. Never edit the generated file.

The first admin is set in D1; after that, admins grant the role through
`POST /api/auth/admin/set-role`:

```bash
wrangler d1 execute DB --remote -c wrangler.production.jsonc \
  --command "UPDATE user SET role = 'admin' WHERE email = '<your email>'"
```

## Recurring

- **Apple client secret** expires after 6 months: rerun `scripts/apple-secret.mjs`, put the result in
  `.env.production` and `pnpm bootstrap` before then.
- **Watch the cleanup log** (`cleanup {...}` hourly): `dbBytes` and `inboxBytes` approaching 10 GB
  means it is time for the mitigations in [cost.md](cost.md); repeated "ran out of time" warnings
  mean deletes are falling behind writes.
- **DLQ** `edgebase-push-dlq` has no consumer; inspect it in the dashboard when pushes go missing.

## Clients

- Web: `better-auth/client` with cookies; FCM web token from the Firebase JS SDK, then `PUT /v1/devices`.
- Expo: `@better-auth/expo` client; Google/Apple ID token sign-in; FCM token via React Native Firebase.
- Flutter: REST with `Authorization: Bearer` (token from the `set-auth-token` header on sign-in);
  GitHub via browser OAuth with `callbackURL = <BASE_URL>/v1/auth/app-callback?challenge=<c>`, then
  `POST /v1/auth/app-exchange { token, verifier }` (see [api.md](api.md)).
- Web on another origin: list it in `TRUSTED_ORIGINS`; CORS with credentials is then allowed.
- Android apps create two notification channels: `default` and `promotions`.
- Web apps subscribe to topics through `POST /v1/topics/{topic}/subscribe { token }`; the
  Firebase JS SDK cannot.
- On a notification tap, apps send `POST /v1/opens { pushId }` with the push's `data.pushId`.
- 2FA: a sign-in answering `{ twoFactorRedirect: true }` sets a short-lived `better-auth.two_factor`
  cookie; send it back with `POST /api/auth/two-factor/verify-totp { code }` (or
  `verify-backup-code`). Expo's client keeps it; Flutter must store and resend that cookie.

Calls that keep requests (the cost that grows with users) low:

- Load the inbox with `GET /v1/inbox`; its `unreadCount` sets the badge, no second call needed.
- `PUT /v1/devices` only when the FCM token changes, or once a week; the server refreshes a device
  at most weekly anyway.
- Refresh the badge when a push arrives instead of polling `unread-count`.
- Timers and reminders the device can compute (end of a session, a daily alarm) are local
  notifications, not pushes.
- Broadcast topics: subscribe with the FCM SDK (`subscribeToTopic`); subscribe to a marketing
  topic only after the user opts in, since FCM delivers to every subscribed device. Broadcasts
  can only be marked read all at once, so call `POST /v1/inbox/read-all` when the inbox screen
  opens.
