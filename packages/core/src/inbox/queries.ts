import { sql } from "../db/registry";
import { encodeCursor } from "../http";
import type { Category, PushPayload } from "../push/types";
import {
  bucketOf,
  bucketOfId,
  bucketTable,
  bucketWindow,
  existingBucketTables,
  LEGACY_TABLE,
  tablesOf,
  withBuckets,
} from "./buckets";

export { ensureBuckets, existingBucketTables } from "./buckets";

// This module's statements, named for the plan test and D1 metrics (see db/registry.ts).
export const BROADCAST_INSERT = sql(
  "inbox.broadcast.insert",
  "INBOX_DB",
  "INSERT INTO broadcast (title, body, data, category, created_at) VALUES (?, ?, ?, ?, ?)",
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

export const INBOX_WATERMARK = sql(
  "inbox.watermark",
  "INBOX_DB",
  "SELECT read_at FROM inbox_state WHERE user_id = ?",
);

const deleteUserItemsSql = (table: string) =>
  sql("inbox.deleteUserItems", "INBOX_DB", `DELETE FROM ${table} WHERE user_id = ?`);

/** Removes everything the inbox holds for a user; INBOX_DB has no foreign key to `user`. */
export async function deleteUserInbox(db: D1Database, userId: string): Promise<void> {
  const run = async () => {
    const tables = [LEGACY_TABLE, ...(await existingBucketTables(db))];
    await db.batch([
      ...tables.map((t) => db.prepare(deleteUserItemsSql(t)).bind(userId)),
      db.prepare(INBOX_DELETE_USER_STATE).bind(userId),
    ]);
  };
  try {
    await run();
  } catch (error) {
    // The cleanup dropped a listed week in between: list again rather than re-create it.
    if (!/no such table: inbox_item_w\d+/.test(String(error))) throw error;
    await run();
  }
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
  if (statements.length === 0) return;
  await withBuckets(db, [bucketOf(now)], () => db.batch(statements));
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
        .prepare(personalInsertSql(bucketTable(bucketOf(now)), chunk.length))
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
  // A week's table may not exist yet; withBuckets creates it and runs the batch again.
  await withBuckets(db, [bucketOf(now)], async () => {
    try {
      await db.batch([db.prepare(INBOX_PUSH_INSERT).bind(pushId, now), ...statements]);
    } catch (error) {
      // The batch rolled back; it failed on our duplicate key only if the row is there now.
      const stored = await db.prepare(INBOX_PUSH_EXISTS).bind(pushId).first();
      if (!stored) throw error;
    }
  });
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

// The inbox's variable statements. Personal items live in one table per week (see buckets.ts),
// so a statement names the tables of the TTL window; each shape is registered with a sample
// (the legacy table and week 0) for the plan test, and each runtime variant under the same name.
const personalInsertSql = (table: string, rows: number) =>
  sql(
    "inbox.personal.insert",
    "INBOX_DB",
    `INSERT INTO ${table} (user_id, title, body, data, category, created_at) VALUES ${Array.from(
      { length: rows },
      () => "(?, ?, ?, ?, ?, ?)",
    ).join(", ")}`,
  );

const broadcastFilterSql = (marketingOptIn: boolean) =>
  marketingOptIn ? "" : " AND category <> 'marketing'";
const afterSql = (cursor: boolean, k: number, first: number) =>
  cursor ? ` AND (created_at, ${k}, id) < (?${first}, ?${first + 1}, ?${first + 2})` : "";
const variant = (cursor: boolean, optIn: boolean) =>
  `${cursor ? ".after" : ""}${optIn ? "" : ".noMarketing"}`;

/**
 * A user's newest personal items in one table, at most ?4 rows in order: a read runs one per
 * table of its window in the same batch and merges them, since D1 allows only 5 terms in a
 * compound SELECT. ?1 user, ?2 cutoff, ?3 now, ?4 limit, ?5-?7 cursor.
 */
const personalPageSql = (table: string, cursor: boolean) =>
  sql(
    `inbox.page.personal${cursor ? ".after" : ""}`,
    "INBOX_DB",
    `SELECT id, title, body, data, category, read_at, created_at FROM ${table}
    WHERE user_id = ?1 AND created_at BETWEEN ?2 AND ?3${afterSql(cursor, 1, 5)}
    ORDER BY created_at DESC, id DESC LIMIT ?4`,
  );

/** Unread personal items across `tables`, for ?1 user, ?2 cutoff, ?4 now, against watermark w.r. */
const unreadPersonalSql = (tables: string[]) =>
  tables
    .map(
      (t) => `(SELECT count(*) FROM ${t} WHERE user_id = ?1 AND created_at BETWEEN ?2 AND ?4
         AND created_at > w.r AND read_at IS NULL)`,
    )
    .join(" + ");

const pageMetaSql = (tables: string[], optIn: boolean) =>
  sql(
    `inbox.pageMeta${variant(false, optIn)}`,
    "INBOX_DB",
    `WITH w AS (SELECT COALESCE((SELECT read_at FROM inbox_state WHERE user_id = ?1), 0) AS r)
    SELECT
      w.r AS readUntil,
      ${unreadPersonalSql(tables)}
      + (SELECT count(*) FROM broadcast WHERE created_at BETWEEN ?2 AND ?4 AND created_at > w.r
         AND created_at > ?3${broadcastFilterSql(optIn)}) AS unreadCount
    FROM w`,
  );

const unreadCountSql = (tables: string[], optIn: boolean) =>
  sql(
    `inbox.unreadCount${variant(false, optIn)}`,
    "INBOX_DB",
    `WITH w AS (SELECT COALESCE((SELECT read_at FROM inbox_state WHERE user_id = ?1), 0) AS r)
    SELECT
      ${unreadPersonalSql(tables)}
      + (SELECT count(*) FROM broadcast WHERE created_at BETWEEN ?2 AND ?4 AND created_at > w.r
         AND created_at > ?3${broadcastFilterSql(optIn)}) AS n
    FROM w`,
  );

const broadcastPageSql = (cursor: boolean, optIn: boolean) =>
  sql(
    `inbox.page.broadcast${variant(cursor, optIn)}`,
    "INBOX_DB",
    `SELECT id, title, body, data, category, NULL AS read_at, created_at FROM broadcast
    WHERE created_at BETWEEN ? AND ? AND created_at > ?${broadcastFilterSql(optIn)}${cursor ? " AND (created_at, 0, id) < (?, ?, ?)" : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`,
  );

const markReadSql = (table: string) =>
  sql(
    "inbox.markRead",
    "INBOX_DB",
    `UPDATE ${table} SET read_at = ? WHERE user_id = ? AND read_at IS NULL
    AND id IN (SELECT value FROM json_each(?))`,
  );

const deleteItemSql = (table: string) =>
  sql("inbox.deleteItem", "INBOX_DB", `DELETE FROM ${table} WHERE id = ? AND user_id = ?`);

const recentSecurityAlertsSql = (tables: string[]) =>
  sql(
    "inbox.recentSecurityAlerts",
    "INBOX_DB",
    `SELECT ${tables
      .map(
        (t) => `(SELECT count(*) FROM ${t}
      WHERE user_id = ?1 AND created_at > ?2 AND category = 'transactional'
        AND json_extract(data, '$.kind') = 'security_alert')`,
      )
      .join(" + ")} AS n`,
  );

// Samples for the plan test: the legacy table and week 0, which the test creates.
{
  const sample = [LEGACY_TABLE, bucketTable(0)];
  personalInsertSql(bucketTable(0), 1);
  markReadSql(bucketTable(0));
  deleteItemSql(bucketTable(0));
  deleteUserItemsSql(bucketTable(0));
  recentSecurityAlertsSql(sample);
  for (const cursor of [false, true]) {
    for (const table of sample) personalPageSql(table, cursor);
    for (const optIn of [false, true]) broadcastPageSql(cursor, optIn);
  }
  for (const optIn of [false, true]) {
    pageMetaSql(sample, optIn);
    unreadCountSql(sample, optIn);
  }
}

/** How many security alerts a user got since `since`, for the hourly cap of security-alerts.ts. */
export async function recentSecurityAlerts(
  db: D1Database,
  userId: string,
  since: number,
  now: number,
): Promise<number> {
  const weeks = bucketWindow(since, now);
  const n = await withBuckets(db, weeks, () =>
    db
      .prepare(recentSecurityAlertsSql(tablesOf(weeks)))
      .bind(userId, since)
      .first<number>("n"),
  );
  return n ?? 0;
}

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

/** The weeks a read covers: the TTL window, or up to the cursor's week when paging. */
const weeksOf = (q: InboxQuery & { cursor?: Cursor | null }) =>
  bucketWindow(cutoff(q), Math.min(q.now, q.cursor ? q.cursor.t : q.now));

/** One page statement per table of the window, then the broadcasts'. */
function pageStatements(db: D1Database, q: InboxQuery & { cursor: Cursor | null; limit: number }) {
  const cursorParams = q.cursor ? [q.cursor.t, q.cursor.k, q.cursor.i] : [];
  const cursor = q.cursor !== null;
  const personal = tablesOf(weeksOf(q)).map((table) =>
    db
      .prepare(personalPageSql(table, cursor))
      .bind(q.userId, cutoff(q), q.now, q.limit + 1, ...cursorParams),
  );
  const broadcast = db
    .prepare(broadcastPageSql(cursor, q.marketingOptIn))
    .bind(cutoff(q), q.now, q.userCreatedAt, ...cursorParams, q.limit + 1);
  return { personal, broadcast };
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
  const { personal, broadcast } = pageStatements(db, q);
  const [results, readUntil] = await withBuckets(db, weeksOf(q), () =>
    Promise.all([db.batch<Row>([...personal, broadcast]), watermark(db, q.userId)]),
  );
  const rows = results.map((r) => r.results);
  return mergeInboxPage(rows.slice(0, -1).flat(), rows.at(-1) ?? [], readUntil, q.limit);
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
  const { personal, broadcast } = pageStatements(db, q);
  const metaStmt = db
    .prepare(pageMetaSql(tablesOf(weeksOf({ ...q, cursor: null })), q.marketingOptIn))
    .bind(q.userId, cutoff(q), q.userCreatedAt, q.now);
  const results = await withBuckets(db, weeksOf({ ...q, cursor: null }), () =>
    db.batch<Row | { readUntil: number; unreadCount: number }>([
      ...before,
      ...personal,
      broadcast,
      metaStmt,
    ]),
  );
  const page = results.slice(before.length);
  const metaRes = page.at(-1);
  const broadcastRes = page.at(-2);
  const personalRows = page.slice(0, personal.length).flatMap((r) => r.results as Row[]);
  const meta = (metaRes?.results[0] as { readUntil: number; unreadCount: number } | undefined) ?? {
    readUntil: 0,
    unreadCount: 0,
  };
  return {
    ...mergeInboxPage(
      personalRows,
      (broadcastRes?.results ?? []) as Row[],
      meta.readUntil,
      q.limit,
    ),
    unreadCount: meta.unreadCount,
  };
}

export async function unreadCount(db: D1Database, q: InboxQuery): Promise<number> {
  // The watermark is read in the same statement, so a count is one round trip.
  const row = await withBuckets(db, weeksOf(q), () =>
    db
      .prepare(unreadCountSql(tablesOf(weeksOf(q)), q.marketingOptIn))
      .bind(q.userId, cutoff(q), q.userCreatedAt, q.now)
      .first<number>("n"),
  );
  return row ?? 0;
}

/**
 * The tables holding these ids, inside the TTL window ending at `now`: an id names its week, and
 * ids of weeks outside the window (expired, or forged) are dropped rather than looked up.
 */
function tablesForIds(ids: number[], now: number, ttlDays: number): Map<string, number[]> {
  const weeks = new Set(bucketWindow(now - ttlDays * DAY_MS, now));
  const out = new Map<string, number[]>();
  for (const id of ids) {
    const week = bucketOfId(id);
    if (week !== null && !weeks.has(week)) continue;
    const table = week === null ? LEGACY_TABLE : bucketTable(week);
    out.set(table, [...(out.get(table) ?? []), id]);
  }
  return out;
}

/** Marks the caller's personal items read: one statement per week they are in. */
export function markReadStatements(
  db: D1Database,
  userId: string,
  ids: number[],
  now: number,
  ttlDays: number,
): D1PreparedStatement[] {
  // One JSON parameter instead of one per id keeps this under D1's 100 bound parameters.
  return [...tablesForIds(ids, now, ttlDays)].map(([table, inTable]) =>
    db.prepare(markReadSql(table)).bind(now, userId, JSON.stringify(inTable)),
  );
}

/** The weeks `markReadStatements` may touch, for withBuckets. */
export const markReadWeeks = (now: number, ttlDays: number) =>
  bucketWindow(now - ttlDays * DAY_MS, now);

export async function markRead(
  db: D1Database,
  userId: string,
  ids: number[],
  now: number,
  ttlDays: number,
): Promise<void> {
  const statements = markReadStatements(db, userId, ids, now, ttlDays);
  if (statements.length === 0) return;
  await withBuckets(db, markReadWeeks(now, ttlDays), () => db.batch(statements));
}

export const markAllReadStatement = (db: D1Database, userId: string, now: number) =>
  db.prepare(INBOX_MARK_ALL_READ).bind(userId, now);

export async function markAllRead(db: D1Database, userId: string, now: number): Promise<void> {
  await markAllReadStatement(db, userId, now).run();
}

export async function deleteItem(
  db: D1Database,
  userId: string,
  id: number,
  now: number,
  ttlDays: number,
): Promise<boolean> {
  const [entry] = tablesForIds([id], now, ttlDays);
  if (!entry) return false;
  const result = await withBuckets(db, markReadWeeks(now, ttlDays), () =>
    db.prepare(deleteItemSql(entry[0])).bind(id, userId).run(),
  );
  return result.meta.changes > 0;
}
