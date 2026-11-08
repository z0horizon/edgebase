# Deployment

Requirements: a Cloudflare account on the **Workers Paid** plan (password hashing needs more CPU
than the free plan allows, and Email Sending needs Paid), Node.js 22+, pnpm, and
`npx wrangler login`.

## 1. Create the resources

```bash
npx wrangler d1 create edgebase-db
npx wrangler d1 create edgebase-inbox
npx wrangler queues create edgebase-push
npx wrangler queues create edgebase-push-dlq
```

Paste both `database_id`s into `wrangler.jsonc`, then `pnpm types`.

## 2. Configure

In `wrangler.jsonc` `vars`: `BASE_URL` (the Worker's public URL), `TRUSTED_ORIGINS` (web origins,
`<APP_SCHEME>://`, `https://appleid.apple.com`), `APP_SCHEME`, `MAIL_FROM` (an address on a domain
set up for Cloudflare Email Sending), `INBOX_TTL_DAYS`.

Secrets (`npx wrangler secret put <NAME>`):

| Secret | Where to get it |
|---|---|
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud console, OAuth client (web) |
| `APPLE_CLIENT_ID`, `APPLE_APP_BUNDLE_IDENTIFIER` | Apple Developer: Services ID and the app's bundle ID |
| `APPLE_CLIENT_SECRET` | `node scripts/apple-secret.mjs <teamId> <keyId> <servicesId> AuthKey.p8` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `FCM_SERVICE_ACCOUNT` | Firebase console → Service accounts → generate key; the JSON on one line |
| `PUSH_API_KEY` | `openssl rand -base64 32`; give it to your servers |

OAuth redirect URIs: `<BASE_URL>/api/auth/callback/<google|apple|github>`.

Missing `BETTER_AUTH_SECRET` makes all auth routes answer `503`; missing `PUSH_API_KEY` or
`FCM_SERVICE_ACCOUNT` does the same for `/v1/push`.

## 3. Migrate and deploy

```bash
pnpm db:migrate:remote
pnpm run deploy
```

## Recurring

- **Apple client secret** expires after 6 months: rerun `scripts/apple-secret.mjs` and
  `wrangler secret put APPLE_CLIENT_SECRET` before then.
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
