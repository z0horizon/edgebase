import { encodeCursor } from "../http";
import type { Category, PushPayload } from "../push/types";

/** Removes everything the inbox holds for a user; INBOX_DB has no foreign key to `user`. */
export async function deleteUserInbox(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM inbox_item WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM inbox_state WHERE user_id = ?").bind(userId),
  ]);
}

// D1 allows 100 bound parameters per statement; personal rows bind 6 each.
const PERSONAL_ROWS_PER_STATEMENT = 16;

const dataColumn = (p: PushPayload) => (p.data ? JSON.stringify(p.data) : null);

export async function insertPersonal(
  db: D1Database,
  userIds: string[],
  p: PushPayload,
  now: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < userIds.length; i += PERSONAL_ROWS_PER_STATEMENT) {
    const chunk = userIds.slice(i, i + PERSONAL_ROWS_PER_STATEMENT);
    statements.push(
      db
        .prepare(
          `INSERT INTO inbox_item (user_id, title, body, data, category, created_at) VALUES ${chunk
            .map(() => "(?, ?, ?, ?, ?, ?)")
            .join(", ")}`,
        )
        .bind(...chunk.flatMap((id) => [id, p.title, p.body, dataColumn(p), p.category, now])),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

export async function insertBroadcast(db: D1Database, p: PushPayload, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO broadcast (title, body, data, category, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(p.title, p.body, dataColumn(p), p.category, now)
    .run();
}

const DAY_MS = 86_400_000;
const PERSONAL = 1;
const BROADCAST = 0;

type InboxEntry = {
  id: string;
  kind: "personal" | "broadcast";
  title: string;
  body: string;
  data: Record<string, string> | null;
  category: Category;
  read: boolean;
  createdAt: number;
};

/** Position of the last returned row in the (created_at, kind, id) DESC order. */
export type Cursor = { t: number; k: 0 | 1; i: number };

type InboxQuery = {
  userId: string;
  userCreatedAt: number;
  /** Marketing broadcasts reach only users who opted in, like marketing pushes do. */
  marketingOptIn: boolean;
  now: number;
  ttlDays: number;
};

const broadcastFilter = (q: InboxQuery) => (q.marketingOptIn ? "" : " AND category <> 'marketing'");

type Row = {
  id: number;
  title: string;
  body: string;
  data: string | null;
  category: Category;
  read_at: number | null;
  created_at: number;
};

async function watermark(db: D1Database, userId: string): Promise<number> {
  return (
    (await db
      .prepare("SELECT read_at FROM inbox_state WHERE user_id = ?")
      .bind(userId)
      .first<number>("read_at")) ?? 0
  );
}

// Reads are a snapshot "as of now": rows past the TTL or stamped after `now` are left out.
const cutoff = (q: InboxQuery) => q.now - q.ttlDays * DAY_MS;

export async function listInbox(
  db: D1Database,
  q: InboxQuery & { cursor: Cursor | null; limit: number },
): Promise<{ items: InboxEntry[]; nextCursor: string | null }> {
  const after = (k: number) => (q.cursor ? ` AND (created_at, ${k}, id) < (?, ?, ?)` : "");
  const cursorParams = q.cursor ? [q.cursor.t, q.cursor.k, q.cursor.i] : [];
  const [personal, broadcasts, readUntil] = await Promise.all([
    db
      .prepare(
        `SELECT id, title, body, data, category, read_at, created_at FROM inbox_item
         WHERE user_id = ? AND created_at BETWEEN ? AND ?${after(PERSONAL)}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(q.userId, cutoff(q), q.now, ...cursorParams, q.limit + 1)
      .all<Row>(),
    db
      .prepare(
        `SELECT id, title, body, data, category, NULL AS read_at, created_at FROM broadcast
         WHERE created_at BETWEEN ? AND ? AND created_at > ?${broadcastFilter(q)}${after(BROADCAST)}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(cutoff(q), q.now, q.userCreatedAt, ...cursorParams, q.limit + 1)
      .all<Row>(),
    watermark(db, q.userId),
  ]);

  const merged = [
    ...personal.results.map((r) => ({ r, k: PERSONAL as 0 | 1 })),
    ...broadcasts.results.map((r) => ({ r, k: BROADCAST as 0 | 1 })),
  ].sort((a, b) => b.r.created_at - a.r.created_at || b.k - a.k || b.r.id - a.r.id);

  const page = merged.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ r, k }) => ({
      id: `${k === PERSONAL ? "p" : "b"}_${r.id}`,
      kind: k === PERSONAL ? "personal" : "broadcast",
      title: r.title,
      body: r.body,
      data: r.data ? (JSON.parse(r.data) as Record<string, string>) : null,
      category: r.category,
      read: r.read_at !== null || r.created_at <= readUntil,
      createdAt: r.created_at,
    })),
    nextCursor:
      merged.length > q.limit && last
        ? encodeCursor({ t: last.r.created_at, k: last.k, i: last.r.id } satisfies Cursor)
        : null,
  };
}

export async function unreadCount(db: D1Database, q: InboxQuery): Promise<number> {
  const readUntil = await watermark(db, q.userId);
  const row = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM inbox_item WHERE user_id = ?1 AND created_at BETWEEN ?2 AND ?5
            AND created_at > ?3 AND read_at IS NULL)
       + (SELECT count(*) FROM broadcast WHERE created_at BETWEEN ?2 AND ?5 AND created_at > ?3
            AND created_at > ?4${broadcastFilter(q)}) AS n`,
    )
    .bind(q.userId, cutoff(q), readUntil, q.userCreatedAt, q.now)
    .first<number>("n");
  return row ?? 0;
}

export async function markRead(
  db: D1Database,
  userId: string,
  ids: number[],
  now: number,
): Promise<void> {
  if (ids.length === 0) return;
  // One JSON parameter instead of one per id keeps this under D1's 100 bound parameters.
  await db
    .prepare(
      `UPDATE inbox_item SET read_at = ? WHERE user_id = ? AND read_at IS NULL
       AND id IN (SELECT value FROM json_each(?))`,
    )
    .bind(now, userId, JSON.stringify(ids))
    .run();
}

export async function markAllRead(db: D1Database, userId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO inbox_state (user_id, read_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET read_at = excluded.read_at`,
    )
    .bind(userId, now)
    .run();
}

export async function deleteItem(db: D1Database, userId: string, id: number): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM inbox_item WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return result.meta.changes > 0;
}
