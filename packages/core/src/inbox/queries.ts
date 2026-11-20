import { sql } from "../db/registry";
import { encodeCursor } from "../http";
import type { Category, PushPayload } from "../push/types";

// This module's statements, named for the plan test and D1 metrics (see db/registry.ts).
export const BROADCAST_INSERT = sql(
  "inbox.broadcast.insert",
  "INBOX_DB",
  "INSERT INTO broadcast (title, body, data, category, created_at) VALUES (?, ?, ?, ?, ?)",
);

export const INBOX_DELETE_ITEM = sql(
  "inbox.deleteItem",
  "INBOX_DB",
  "DELETE FROM inbox_item WHERE id = ? AND user_id = ?",
);

export const INBOX_DELETE_USER_ITEMS = sql(
  "inbox.deleteUserItems",
  "INBOX_DB",
  "DELETE FROM inbox_item WHERE user_id = ?",
);

export const INBOX_DELETE_USER_STATE = sql(
  "inbox.deleteUserState",
  "INBOX_DB",
  "DELETE FROM inbox_state WHERE user_id = ?",
);

export const INBOX_MARK_ALL_READ = sql(
  "inbox.markAllRead",
  "INBOX_DB",
  `INSERT INTO inbox_state (user_id, read_at) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET read_at = excluded.read_at`,
);

export const INBOX_MARK_READ = sql(
  "inbox.markRead",
  "INBOX_DB",
  `UPDATE inbox_item SET read_at = ? WHERE user_id = ? AND read_at IS NULL
    AND id IN (SELECT value FROM json_each(?))`,
);

export const INBOX_PUSH_EXISTS = sql(
  "inbox.push.exists",
  "INBOX_DB",
  "SELECT 1 AS x FROM inbox_push WHERE id = ?",
);

export const INBOX_PUSH_INSERT = sql(
  "inbox.push.insert",
  "INBOX_DB",
  "INSERT INTO inbox_push (id, created_at) VALUES (?, ?)",
);

export const INBOX_RECENT_SECURITY_ALERTS = sql(
  "inbox.recentSecurityAlerts",
  "INBOX_DB",
  `SELECT count(*) AS n FROM inbox_item
    WHERE user_id = ? AND created_at > ? AND category = 'transactional'
      AND json_extract(data, '$.kind') = 'security_alert'`,
);

export const INBOX_WATERMARK = sql(
  "inbox.watermark",
  "INBOX_DB",
  "SELECT read_at FROM inbox_state WHERE user_id = ?",
);

/** Removes everything the inbox holds for a user; INBOX_DB has no foreign key to `user`. */
export async function deleteUserInbox(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare(INBOX_DELETE_USER_ITEMS).bind(userId),
    db.prepare(INBOX_DELETE_USER_STATE).bind(userId),
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
  const statements = personalStatements(db, userIds, p, now);
  if (statements.length > 0) await db.batch(statements);
}

/** The inserts of `insertPersonal`, for callers that write several payloads in one atomic batch. */
export function personalStatements(
  db: D1Database,
  userIds: string[],
  p: PushPayload,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < userIds.length; i += PERSONAL_ROWS_PER_STATEMENT) {
    const chunk = userIds.slice(i, i + PERSONAL_ROWS_PER_STATEMENT);
    statements.push(
      db
        .prepare(personalInsertSql(chunk.length))
        .bind(...chunk.flatMap((id) => [id, p.title, p.body, dataColumn(p), p.category, now])),
    );
  }
  return statements;
}

export function broadcastStatement(
  db: D1Database,
  p: PushPayload,
  now: number,
): D1PreparedStatement {
  return db.prepare(BROADCAST_INSERT).bind(p.title, p.body, dataColumn(p), p.category, now);
}

/**
 * Runs a push's inbox inserts together with its `inbox_push` row in one transaction; a push
 * whose row exists is skipped, so any number of retries store its inbox once.
 */
export async function writeInboxOnce(
  db: D1Database,
  pushId: number,
  statements: D1PreparedStatement[],
  now: number,
): Promise<void> {
  try {
    await db.batch([db.prepare(INBOX_PUSH_INSERT).bind(pushId, now), ...statements]);
  } catch (error) {
    // The batch rolled back; it failed on our duplicate key only if the row is there now.
    const stored = await db.prepare(INBOX_PUSH_EXISTS).bind(pushId).first();
    if (!stored) throw error;
  }
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

// The inbox's variable statements: every variant is built and registered here, so the plan test
// sees each one, and a read picks its variant by name.
const personalInsertSql = (rows: number) =>
  sql(
    "inbox.personal.insert",
    "INBOX_DB",
    `INSERT INTO inbox_item (user_id, title, body, data, category, created_at) VALUES ${Array.from(
      { length: rows },
      () => "(?, ?, ?, ?, ?, ?)",
    ).join(", ")}`,
  );
personalInsertSql(1);

const broadcastFilterSql = (marketingOptIn: boolean) =>
  marketingOptIn ? "" : " AND category <> 'marketing'";
const afterSql = (cursor: boolean, k: number) =>
  cursor ? ` AND (created_at, ${k}, id) < (?, ?, ?)` : "";
const variant = (cursor: boolean, optIn: boolean) =>
  `${cursor ? ".after" : ""}${optIn ? "" : ".noMarketing"}`;

const PAGE = new Map<string, string>();
const META = new Map<boolean, string>();
const UNREAD = new Map<boolean, string>();
for (const cursor of [false, true]) {
  PAGE.set(
    `personal${cursor}`,
    sql(
      `inbox.page.personal${cursor ? ".after" : ""}`,
      "INBOX_DB",
      `SELECT id, title, body, data, category, read_at, created_at FROM inbox_item
    WHERE user_id = ? AND created_at BETWEEN ? AND ?${afterSql(cursor, 1)}
    ORDER BY created_at DESC, id DESC LIMIT ?`,
    ),
  );
  for (const optIn of [false, true]) {
    PAGE.set(
      `broadcast${cursor}${optIn}`,
      sql(
        `inbox.page.broadcast${variant(cursor, optIn)}`,
        "INBOX_DB",
        `SELECT id, title, body, data, category, NULL AS read_at, created_at FROM broadcast
    WHERE created_at BETWEEN ? AND ? AND created_at > ?${broadcastFilterSql(optIn)}${afterSql(cursor, 0)}
    ORDER BY created_at DESC, id DESC LIMIT ?`,
      ),
    );
  }
}
for (const optIn of [false, true]) {
  META.set(
    optIn,
    sql(
      `inbox.pageMeta${variant(false, optIn)}`,
      "INBOX_DB",
      `WITH w AS (SELECT COALESCE((SELECT read_at FROM inbox_state WHERE user_id = ?1), 0) AS r)
    SELECT
      w.r AS readUntil,
      (SELECT count(*) FROM inbox_item WHERE user_id = ?1 AND created_at BETWEEN ?2 AND ?4
         AND created_at > w.r AND read_at IS NULL)
      + (SELECT count(*) FROM broadcast WHERE created_at BETWEEN ?2 AND ?4 AND created_at > w.r
         AND created_at > ?3${broadcastFilterSql(optIn)}) AS unreadCount
    FROM w`,
    ),
  );
  UNREAD.set(
    optIn,
    sql(
      `inbox.unreadCount${variant(false, optIn)}`,
      "INBOX_DB",
      `WITH w AS (SELECT COALESCE((SELECT read_at FROM inbox_state WHERE user_id = ?1), 0) AS r)
    SELECT
      (SELECT count(*) FROM w, inbox_item WHERE user_id = ?1 AND created_at BETWEEN ?2 AND ?4
         AND created_at > w.r AND read_at IS NULL)
    + (SELECT count(*) FROM w, broadcast WHERE created_at BETWEEN ?2 AND ?4 AND created_at > w.r
         AND created_at > ?3${broadcastFilterSql(optIn)}) AS n`,
    ),
  );
}
const pick = <K>(map: Map<K, string>, key: K): string => {
  const text = map.get(key);
  if (text === undefined) throw new Error(`no inbox statement for ${String(key)}`);
  return text;
};

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
  return (await db.prepare(INBOX_WATERMARK).bind(userId).first<number>("read_at")) ?? 0;
}

// Reads are a snapshot "as of now": rows past the TTL or stamped after `now` are left out.
const cutoff = (q: InboxQuery) => q.now - q.ttlDays * DAY_MS;

function pageStatements(db: D1Database, q: InboxQuery & { cursor: Cursor | null; limit: number }) {
  const cursorParams = q.cursor ? [q.cursor.t, q.cursor.k, q.cursor.i] : [];
  const cursor = q.cursor !== null;
  return [
    db
      .prepare(pick(PAGE, `personal${cursor}`))
      .bind(q.userId, cutoff(q), q.now, ...cursorParams, q.limit + 1),
    db
      .prepare(pick(PAGE, `broadcast${cursor}${q.marketingOptIn}`))
      .bind(cutoff(q), q.now, q.userCreatedAt, ...cursorParams, q.limit + 1),
  ] as const;
}

function mergeInboxPage(
  personal: Row[],
  broadcasts: Row[],
  readUntil: number,
  limit: number,
): { items: InboxEntry[]; nextCursor: string | null } {
  const merged = [
    ...personal.map((r) => ({ r, k: PERSONAL as 0 | 1 })),
    ...broadcasts.map((r) => ({ r, k: BROADCAST as 0 | 1 })),
  ].sort((a, b) => b.r.created_at - a.r.created_at || b.k - a.k || b.r.id - a.r.id);

  const page = merged.slice(0, limit);
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
      merged.length > limit && last
        ? encodeCursor({ t: last.r.created_at, k: last.k, i: last.r.id } satisfies Cursor)
        : null,
  };
}

export async function listInbox(
  db: D1Database,
  q: InboxQuery & { cursor: Cursor | null; limit: number },
): Promise<{ items: InboxEntry[]; nextCursor: string | null }> {
  const [personalStmt, broadcastStmt] = pageStatements(db, q);
  const [personal, broadcasts, readUntil] = await Promise.all([
    personalStmt.all<Row>(),
    broadcastStmt.all<Row>(),
    watermark(db, q.userId),
  ]);
  return mergeInboxPage(personal.results, broadcasts.results, readUntil, q.limit);
}

/** Fetches the merged inbox page, watermark, and unread count in a single INBOX_DB batch. */
/**
 * `before` (writes such as marking read) runs first in the same batch: D1 runs a batch in order
 * in one transaction, so the page already sees them, at no extra round trip.
 */
export async function listInboxWithUnread(
  db: D1Database,
  q: InboxQuery & { cursor: Cursor | null; limit: number },
  before: D1PreparedStatement[] = [],
): Promise<{ items: InboxEntry[]; nextCursor: string | null; unreadCount: number }> {
  const [personalStmt, broadcastStmt] = pageStatements(db, q);
  const metaStmt = db
    .prepare(pick(META, q.marketingOptIn))
    .bind(q.userId, cutoff(q), q.userCreatedAt, q.now);
  const results = await db.batch<Row | { readUntil: number; unreadCount: number }>([
    ...before,
    personalStmt,
    broadcastStmt,
    metaStmt,
  ]);
  const [personalRes, broadcastRes, metaRes] = results.slice(before.length);
  const meta = (metaRes?.results[0] as { readUntil: number; unreadCount: number } | undefined) ?? {
    readUntil: 0,
    unreadCount: 0,
  };
  return {
    ...mergeInboxPage(
      (personalRes?.results ?? []) as Row[],
      (broadcastRes?.results ?? []) as Row[],
      meta.readUntil,
      q.limit,
    ),
    unreadCount: meta.unreadCount,
  };
}

export async function unreadCount(db: D1Database, q: InboxQuery): Promise<number> {
  // The watermark is read in the same statement, so a count is one round trip.
  const row = await db
    .prepare(pick(UNREAD, q.marketingOptIn))
    .bind(q.userId, cutoff(q), q.userCreatedAt, q.now)
    .first<number>("n");
  return row ?? 0;
}

/** Marks the caller's personal items read; null when there is nothing to mark. */
export function markReadStatement(
  db: D1Database,
  userId: string,
  ids: number[],
  now: number,
): D1PreparedStatement | null {
  if (ids.length === 0) return null;
  // One JSON parameter instead of one per id keeps this under D1's 100 bound parameters.
  return db.prepare(INBOX_MARK_READ).bind(now, userId, JSON.stringify(ids));
}

export async function markRead(
  db: D1Database,
  userId: string,
  ids: number[],
  now: number,
): Promise<void> {
  await markReadStatement(db, userId, ids, now)?.run();
}

export const markAllReadStatement = (db: D1Database, userId: string, now: number) =>
  db.prepare(INBOX_MARK_ALL_READ).bind(userId, now);

export async function markAllRead(db: D1Database, userId: string, now: number): Promise<void> {
  await markAllReadStatement(db, userId, now).run();
}

export async function deleteItem(db: D1Database, userId: string, id: number): Promise<boolean> {
  const result = await db.prepare(INBOX_DELETE_ITEM).bind(id, userId).run();
  return result.meta.changes > 0;
}
