# Inbox

The in-app inbox lists the notifications a user received, newest first, in `INBOX_DB`, a D1
database separate from auth so the largest, most-written table cannot slow sign-in. Personal
items are one row per user; a broadcast is one row for everyone.

## Entities

- **`inbox_item`** (`migrations-inbox/0001_init.sql`): `id` (integer rowid), `user_id`, `title`,
  `body`, `data` (JSON text or null), `category`, `read_at` (epoch ms or null), `created_at`.
  `INDEX(user_id, id)`. No foreign key: `user` lives in the other database.
- **`broadcast`**: `id`, `title`, `body`, `data`, `category`, `created_at`. No index besides the rowid.
- **`inbox_state`**: `user_id` → `read_at`, the "read all" watermark.
- **`InboxEntry`** (API shape, `src/inbox/queries.ts`): `id` (`p_<rowid>` or `b_<rowid>`), `kind`
  (`personal` | `broadcast`), `title`, `body`, `data`, `category`, `read`, `createdAt`.

## Rules

1. A user's inbox is their `inbox_item` rows plus every `broadcast` created after the user's
   `createdAt`, both limited to `created_at` within the last `INBOX_TTL_DAYS` (default 30) and not
   after now (`listInbox`). Broadcasts with `category: "marketing"` are left out for users whose
   `marketingOptIn` is off, matching who receives marketing pushes.
2. Order is `created_at` DESC, then personal before broadcast, then `id` DESC. The cursor is the
   base64url JSON `{ t, k, i }` of the last returned row; a cursor that does not decode to that
   shape answers `400 invalid_cursor` (`src/inbox/routes.ts`).
3. `limit` defaults to 20 and is clamped to 1–100; a non-number uses the default.
4. A personal item is read when `read_at` is set or it is not newer than the watermark; a
   broadcast is read when it is not newer than the watermark. There is no per-user row per
   broadcast.
5. `POST /v1/inbox/read { ids }` marks the caller's personal items; `b_` ids and unknown ids are
   ignored. At most 100 ids per call.
6. `POST /v1/inbox/read-all` sets the watermark to now: one write regardless of inbox size.
7. `DELETE /v1/inbox/:id` deletes a personal item of the caller (`404` otherwise). Broadcasts
   cannot be deleted per user.
8. Deleting a user removes their `inbox_item` and `inbox_state` rows (see auth-and-users rule 6).
