# Inbox

The in-app inbox lists the notifications a user received, newest first, in `INBOX_DB`, a D1
database separate from auth so the largest, most-written table cannot slow sign-in. Personal
items are one row per user; a broadcast is one row for everyone.

## Entities

- **Week tables `inbox_item_w<n>`** (`packages/core/src/inbox/buckets.ts`): personal items of week
  `n` (`floor(created_at / 7 days)`), with the columns and index of `inbox_item` below. Made by
  code (the cleanup cron ahead of time, or a statement that finds its table missing), not by
  migrations; week `n`'s ids start above `n × 2^32` (a sentinel row no user owns), so an id names
  its week. Retention drops a whole week table.
- **`inbox_item`** (`packages/core/migrations-inbox/0001_init.sql`): items stored before week tables
  (ids below `2^32`); still read and cleaned row by row until its last item expires. `id` (integer rowid), `user_id`, `title`,
  `body`, `data` (JSON text or null), `category`, `read_at` (epoch ms or null), `created_at`.
  `INDEX(user_id, created_at, id)`, matching the read order. No foreign key: `user` lives in the other database.
- **`broadcast`**: `id`, `title`, `body`, `data`, `category`, `created_at`. `INDEX(created_at, id)` (`0003`).
- **`inbox_state`**: `user_id` → `read_at`, the "read all" watermark.
- **`InboxEntry`** (API shape, `packages/core/src/inbox/queries.ts`): `id` (`p_<id>` or `b_<rowid>`), `kind`
  (`personal` | `broadcast`), `title`, `body`, `data`, `category`, `read`, `createdAt`.

## Rules

1. A user's inbox is their personal rows (in `inbox_item` and the week tables of the window) plus every `broadcast` created after the user's
   `createdAt`, both limited to `created_at` within the last `INBOX_TTL_DAYS` (1 to 90, default 30) and not
   after now (`listInbox`). Broadcasts with `category: "marketing"` are left out for users whose
   `marketingOptIn` is off, matching who receives marketing pushes.
2. Order is `created_at` DESC, then personal before broadcast, then `id` DESC. The cursor is the
   base64url JSON `{ t, k, i }` of the last returned row; a cursor that does not decode to that
   shape answers `400 invalid_cursor` (`packages/core/src/inbox/routes.ts`).
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
9. `POST /v1/sync` (`packages/core/src/sync.ts`) applies `read` or `readAll`, a device registration
   and open reports, then answers the user and the first inbox page with `unreadCount`, so one
   request replaces the separate calls an app makes on start. Each part follows the rule of the
   route it stands for.
10. After the inbox gains an item, open realtime sockets get `{"type":"inbox"}` (see
    [realtime.md](realtime.md)): personal items of a push with `inbox: true` (from the queue
    consumer, first attempt only), broadcasts (marketing ones to opted-in users), and security
    alerts. The event is best effort and never fails the write: a socket that is reconnecting, or
    a batch whose first attempt failed before hinting, misses it, so clients read on (re)connect.
11. A read covers the legacy table and every week of its window (`ceil(INBOX_TTL_DAYS / 7) + 1`
    at most: 6 with the default 30 days, 14 with the cap of 90), one statement per table in one
    batch, merged in order; D1 allows only 5 terms in a compound
    SELECT, so they are not one UNION. `read` and `DELETE` look up an id only in its own week, and
    ignore ids of weeks outside the TTL window, so a forged id never makes a table.
