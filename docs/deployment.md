# Deployment

Requirements: a Cloudflare account on the **Workers Paid** plan (password hashing needs more CPU
than the free plan allows, and Email Sending needs Paid), Node.js 22+, pnpm, and
`npx wrangler login`. Run the `pnpm` commands below from the repository root; the files they
read and write (`.env.production`, `.dev.vars`, `wrangler.jsonc`, `scripts/`) are in `apps/server/`.
Upgrading a copy from before the workspace layout: see
[extending.md](extending.md#from-the-single-package-layout).

## 1. Bootstrap

```bash
pnpm bootstrap          # add --yes to never prompt (CI); it then fails on any missing value
```

It asks for what `.env.production` lacks, then:

1. checks the Wrangler login, and picks the account (`CLOUDFLARE_ACCOUNT_ID`) when there are several;
2. generates `BETTER_AUTH_SECRET` and `PUSH_API_KEY` when empty, and sets `APP_NAME` to
   `PROJECT_NAME` when empty;
3. finds or creates the D1 databases `<PROJECT_NAME>-db` and `<PROJECT_NAME>-inbox` and stores
   their IDs;
4. creates the queues `<PROJECT_NAME>-push` and `<PROJECT_NAME>-push-dlq` when missing;
5. writes `wrangler.production.jsonc` and applies the remote migrations;
6. uploads every secret with `wrangler secret bulk` (a draft Worker is created if none exists yet);
7. creates the first admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD` (see below; skipped with
   `--yes` when `ADMIN_EMAIL` is empty);
8. creates `.dev.vars` for local dev, or fills its empty secrets, never replacing a value.

`PROJECT_NAME` names the Cloudflare resources and cannot change without moving data (a new name
creates a new, empty Worker and databases). `APP_NAME` is only the name people see: mail
subjects, authenticator and passkey labels, and the admin page. Change it in `.env.production`
and redeploy at any time; authenticators and passkeys set up before keep the old label.

Rerun it any time: each step skips what already exists. Every key of `.env.production` is
explained in [`.env.production.example`](../apps/server/.env.production.example).

`.env.production` is the source of truth for secrets: a secret that is empty there is deleted from
the Worker on the next bootstrap, including one set by hand with `wrangler secret put`.

## 2. Sign-in providers and push

Fill in the optional keys of `.env.production`, then `pnpm bootstrap` again:

| Keys | Where to get them |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud console, OAuth client (web; append `,ios-id,android-id` to `GOOGLE_CLIENT_ID` if native SDKs omit `serverClientId`) |
| `APPLE_CLIENT_ID`, `APPLE_APP_BUNDLE_IDENTIFIER` | Apple Developer: Services ID and the app's bundle ID |
| `APPLE_CLIENT_SECRET` | `node apps/server/scripts/apple-secret.mjs <teamId> <keyId> <servicesId> AuthKey.p8` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `TURNSTILE_SECRET_KEY` | Cloudflare dashboard → Turnstile → add a widget (free); its secret key. Required unless `EMAIL_PASSWORD=off`, so bots cannot send sign-up and reset mail at your cost; the apps send the widget's token (see [api.md](api.md#authentication)) |
| `FCM_SERVICE_ACCOUNT_FILE` | Firebase console → Service accounts → generate key; the path to the JSON file |

OAuth redirect URIs: `<BASE_URL>/api/auth/callback/<google|apple|github>`. A provider whose ID or
secret is unset is simply off, so you can deploy with email sign-in only and add providers later.

**Provider-only apps** (for example Google only): set `EMAIL_PASSWORD=off`. Email and password
sign-in, sign-up, password reset and verification mail then answer `404`, so nobody can use the
mail sender or guess passwords, and Turnstile is not needed. iOS apps that offer Google sign-in
must also offer Sign in with Apple (App Store review guideline 4.8). Organization invitations
still send mail.

To send no mail at all, also set `EMAIL_SENDING=off`: the deploy then carries no mail binding, so
Email Sending needs no set-up and `MAIL_FROM` may stay empty. Security alerts (a sign-in from a new
network, a new passkey) still reach the in-app inbox; organization invitations are created but not
mailed, so your app has to show them.

Missing `BETTER_AUTH_SECRET` makes all auth routes answer `503`; missing `PUSH_API_KEY` or
`FCM_SERVICE_ACCOUNT` does the same for `/v1/push`. Give `PUSH_API_KEY` to your servers.

## 3. Deploy

```bash
pnpm run deploy               # regenerates wrangler.production.jsonc, then wrangler deploy
pnpm db:migrate:remote        # after pulling new migrations
```

Both regenerate `wrangler.production.jsonc` from `wrangler.jsonc` and `.env.production` first, so
template changes (bindings, crons) always reach production. Never edit the generated file.

`pnpm run deploy` also builds the admin page (`apps/admin/`, React + shadcn/ui) into `apps/server/public/admin`; it
is served at `<BASE_URL>/admin/`. Locally, run `pnpm --filter @edgebase/admin build` once so `pnpm dev` serves it, or
`pnpm admin:dev`, which starts the Worker and the page together, for live reload at
`http://localhost:5173/admin/`.

The first admin comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD`: `pnpm bootstrap` asks for the
email, generates the password into `.env.production` and creates the account, verified, with no
mail sent. `pnpm admin:create --remote` does it again, for example to reset that password after
changing it in the file. `pnpm admin:create` does the same for the local database, keeping both
values in `apps/server/.env.local` (gitignored). Further admins are granted from the Users page
(`POST /api/auth/admin/set-role`).

With `EMAIL_PASSWORD=off` there is no admin password: the admin signs in once with a provider as
`ADMIN_EMAIL`, then `pnpm admin:create --remote` (or `pnpm admin:create` locally) makes that account
an admin and signs it out everywhere, so admin rights start from a fresh sign-in. It refuses an
account that can only sign in with a password, and until the account exists bootstrap only says
what to do.

To turn it off on a deployment whose admins already sign in with a password, have each of them link
Google, Apple or GitHub, or add a passkey, under Account & Security first. Once it is off their
password no longer works, and a provider cannot join an existing admin by matching email. Admins can
still set a password for a user from the Users page; it stays unusable until `EMAIL_PASSWORD` is on.

Admins can sign in to the page with Google, GitHub or Apple (whichever are configured in step 2)
with no two-factor:

- **Existing admin** (such as `ADMIN_EMAIL`): sign in with email, password and 2FA, open
  **Account** and link the provider account (same email). Signing in with an unlinked provider
  account fails with `unable to link account`: matching the email at sign-in never links to an
  admin, so owning the admin's inbox is not enough.
- **New admin**: they sign in once with the provider (this creates a plain user), then an admin
  grants the role from the Users page.
- **Apple** "Hide My Email" gives a relay address that matches no existing user; share the real
  email or use another provider.
- **Locally** the provider returns to `http://localhost:8787/admin/`, so build the page once
  (`pnpm --filter @edgebase/admin build`) and register `http://localhost:8787/api/auth/callback/<provider>`
  as a redirect URI of a development OAuth client.

Email + password sign-in needs a passkey or
two-factor: at first sign-in the page lets the admin register a WebAuthn passkey (Touch ID, Face ID,
Windows Hello or security key) or scan a QR code for an authenticator app and save ten
backup codes. An admin who has lost their passkey, authenticator app and backup codes is reset with
`pnpm admin:create --remote --reset-2fa` (with their email as `ADMIN_EMAIL`), and sets one up again.

### Optional: Cloudflare Access in front of the admin page

For a second wall that needs no code, put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
(Zero Trust, free up to 50 users) on `<BASE_URL>/admin/*` and `<BASE_URL>/api/auth/admin/*`, with
a policy that lets in only your admins' emails or identity provider. Do not cover `/api/auth/*`
or `/v1/*` as a whole: apps and your servers call those without an Access login. The page's
other calls (`/v1/push`, `/v1/templates`) stay guarded by the admin session and two-factor.

### Optional: custom domain, WAF and spend limits

A Worker on `workers.dev` has no zone in front of it, so nothing can drop unwanted traffic before
the Worker runs and is billed. To put your zone's rules in front of every request:

1. Add the domain to your Cloudflare account (the Free zone plan is enough), set
   `CUSTOM_DOMAIN=api.example.com` and `BASE_URL=https://api.example.com` in `.env.production`,
   then `pnpm bootstrap` and `pnpm run deploy`. The deploy serves the Worker on that hostname
   (Cloudflare creates the DNS record and certificate) and turns its `workers.dev` and preview
   URLs off, so no address bypasses the zone.
2. Changing `BASE_URL` changes the OAuth redirect URIs (step 2), and passkeys are bound to its
   hostname: passkeys registered on the old hostname stop working. Choose the domain before
   users enroll.
3. In the zone, add a WAF custom rule (the Free plan has 5) that blocks every path the
   Worker does not serve, for example
   `not (starts_with(http.request.uri.path, "/api/auth/") or starts_with(http.request.uri.path, "/v1/") or starts_with(http.request.uri.path, "/admin") or http.request.uri.path eq "/health")`.
   Add your own route prefixes from `apps/server` to it, or the rule blocks them too.
   The Free plan also has one rate limiting rule, per IP over 10 seconds: use it as a flood stop
   (for example 100 requests per 10 seconds), well above what one phone or office network sends.
   Leave Bot Fight Mode off: it challenges API and mobile app traffic, your servers calling
   `/v1/push` included, and no rule can exempt them. Super Bot Fight Mode (Pro) can be skipped
   per path if you need bot filtering.
4. Set a spend limit and budget alerts (dashboard → Billing). The limit covers Workers and
   Durable Objects only, not D1, Queues or Email Sending; recorded spend can pass it before the
   block applies; and at the limit new Worker invocations are blocked, which takes the API down
   until you raise it or the billing period ends. Treat it as a last stop, with the alert well
   below it.

Zone rules stop scanners and floods. They do not stop a signed-in account that calls the API in
a loop; `AUTH_RL`, `TOPIC_RL` and Turnstile (step 2) are the in-Worker limits for that.

## Recurring

- **Apple client secret** expires after 6 months: rerun `apps/server/scripts/apple-secret.mjs`, put the result in
  `.env.production` and `pnpm bootstrap` before then.
- **Watch the cleanup log** (`{"event":"cleanup",...}` hourly): `dbBytes` and `inboxBytes` approaching 10 GB
  means it is time for the mitigations in [cost.md](cost.md); repeated `cleanup_incomplete` warnings
  mean deletes are falling behind writes.
- **DLQ** `edgebase-push-dlq` has no consumer; inspect it in the dashboard when pushes go missing.

## Clients

- On every app start or return to the foreground, one `POST /v1/sync` (see [api.md](api.md)) does
  the device registration, open reports, read marks, user and inbox below in a single request.
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
  cookie; send it back with `POST /api/auth/two-factor/verify-totp { code, trustDevice? }` (or
  `verify-backup-code`). Expo's client keeps cookies; Flutter must store and resend the `two_factor`
  cookie, and when `trustDevice: true` is used, store the `Set-Trust-Device-Token` header, send it
  as `X-Trust-Device-Token` on later `POST /api/auth/sign-in/email` calls, and overwrite the stored
  token with the rotated `Set-Trust-Device-Token` returned by each successful sign-in.

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
