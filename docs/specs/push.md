# Push

Push notifications go out through Firebase Cloud Messaging HTTP v1. Apps register their FCM
token per device; servers send through `POST /v1/push` with an API key; a queue consumer talks to
FCM and retries per token.

## Devices

### Entities

- **`device`** (`migrations/0001_init.sql`): `token` (primary key), `user_id` (FK `user`, cascade),
  `platform` (`web` | `ios` | `android`), `updated_at` (epoch ms). `WITHOUT ROWID`, `INDEX(user_id)`.

### Rules

1. `PUT /v1/devices { token, platform }` registers the caller's token (`src/push/devices.ts`,
   `upsertDevice`). The row is written only when its owner or platform changed or it is at least
   7 days old, so apps can call it on every launch at near-zero write cost.
2. A token already registered by another user moves to the caller (a shared or resold device).
3. A user keeps at most 10 devices; registering an 11th deletes the least recently updated ones.
4. `DELETE /v1/devices/:token` removes the token only if it belongs to the caller, and answers
   `204` either way. Apps call it on sign-out.
5. `token` is 1–4096 characters.
