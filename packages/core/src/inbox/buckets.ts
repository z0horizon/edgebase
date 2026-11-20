import { sql } from "../db/registry";

/**
 * Personal inbox items live in one table per week, `inbox_item_w<n>`, so retention drops a whole
 * table instead of deleting its rows: D1 bills every deleted row as a written row, and a
 * DROP TABLE writes none. Items from before this layout stay in `inbox_item` (the legacy table),
 * which reads keep naming (cheaply, once it is empty) and the cleanup empties row by row.
 *
 * Week n's ids start at `(n + 1) * 2^32` (a sentinel row at that id, which no user owns), so an
 * item id still reads `p_<number>`, names its own week, and never falls in the legacy table's
 * range (below 2^32). Week tables are made by code, not migrations,
 * since a new one is needed every week: `ensureBuckets` (run by the cleanup cron ahead of time,
 * and by `withBuckets` when a statement finds its table missing). They all take this one shape;
 * a later change to it applies to new weeks, and the old ones expire within the TTL.
 */

export const BUCKET_MS = 7 * 86_400_000;
export const LEGACY_TABLE = "inbox_item";
const ID_SPAN = 2 ** 32;
const TABLE_PREFIX = "inbox_item_w";

/** The week an instant falls in. */
export const bucketOf = (t: number): number => Math.floor(t / BUCKET_MS);

export function bucketTable(week: number): string {
  // The name goes into SQL text: only a non-negative safe integer may make it there.
  if (!Number.isSafeInteger(week) || week < 0) throw new Error(`not an inbox week: ${week}`);
  return `${TABLE_PREFIX}${week}`;
}

/** The week an item id belongs to, or null for an id of the legacy table. */
export const bucketOfId = (id: number): number | null =>
  id >= ID_SPAN ? Math.floor(id / ID_SPAN) - 1 : null;

/** Every week from the one holding `from` to the one holding `to`. */
export function bucketWindow(from: number, to: number): number[] {
  const weeks: number[] = [];
  for (let w = bucketOf(Math.max(0, from)); w <= bucketOf(Math.max(0, to)); w++) weeks.push(w);
  return weeks;
}

/** The tables a read over `weeks` names: the legacy table first, then each week's. */
export const tablesOf = (weeks: number[]): string[] => [LEGACY_TABLE, ...weeks.map(bucketTable)];

// Week tables have the legacy table's columns and index; a week starts with its sentinel row.
const createSql = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data TEXT,
    category TEXT NOT NULL,
    read_at INTEGER,
    created_at INTEGER NOT NULL
  )`;
const indexSql = (table: string) =>
  `CREATE INDEX IF NOT EXISTS ${table}_user_created_at ON ${table}(user_id, created_at, id)`;
const sentinelSql = (table: string) =>
  sql(
    "inbox.bucket.sentinel",
    "INBOX_DB",
    `INSERT OR IGNORE INTO ${table} (id, user_id, title, body, category, created_at)
    VALUES (?, '', '', '', 'transactional', ?)`,
  );

/** Creates the tables of `weeks` that do not exist yet; existing ones cost no write. */
export async function ensureBuckets(db: D1Database, weeks: number[]): Promise<void> {
  if (weeks.length === 0) return;
  await db.batch(
    weeks.flatMap((week) => {
      const table = bucketTable(week);
      return [
        db.prepare(createSql(table)),
        db.prepare(indexSql(table)),
        db.prepare(sentinelSql(table)).bind((week + 1) * ID_SPAN, week * BUCKET_MS),
      ];
    }),
  );
}

const LIST_BUCKETS = sql(
  "inbox.bucket.list",
  "INBOX_DB",
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'inbox_item_w[0-9]*'",
);

/** Every week table that exists, oldest first. */
export async function existingBucketTables(db: D1Database): Promise<string[]> {
  const rows = await db.prepare(LIST_BUCKETS).all<{ name: string }>();
  return rows.results
    .map((r) => r.name)
    .filter((name) => /^inbox_item_w\d+$/.test(name))
    .sort((a, b) => weekOfTable(a) - weekOfTable(b));
}

export const weekOfTable = (name: string): number => Number(name.slice(TABLE_PREFIX.length));

const dropSql = (table: string) => `DROP TABLE IF EXISTS ${table}`;

/**
 * Drops week tables whose every item is older than `cutoff`, oldest first and one per statement,
 * stopping once `deadline` has passed (a large table takes a while to free). Returns how many it
 * dropped and whether none is left.
 */
export async function dropExpiredBuckets(
  db: D1Database,
  cutoff: number,
  deadline = Number.POSITIVE_INFINITY,
): Promise<{ dropped: number; complete: boolean }> {
  const expired = (await existingBucketTables(db)).filter(
    (name) => (weekOfTable(name) + 1) * BUCKET_MS <= cutoff,
  );
  let dropped = 0;
  for (const name of expired) {
    if (Date.now() >= deadline) return { dropped, complete: false };
    await db.prepare(dropSql(name)).run();
    dropped++;
  }
  return { dropped, complete: true };
}

const isMissingBucket = (error: unknown) =>
  /no such table: inbox_item_w\d+/.test(String((error as Error | undefined)?.message ?? error));

/**
 * Runs `work`; if it failed because a week table of `weeks` does not exist yet, creates them and
 * runs it once more. A failed batch rolled back, so running it again is safe. A read that took its
 * `now` just before the cron dropped its oldest week can make that week again (5 writes, empty);
 * the next cleanup drops it.
 */
export async function withBuckets<T>(
  db: D1Database,
  weeks: number[],
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isMissingBucket(error)) throw error;
    await ensureBuckets(db, weeks);
    return work();
  }
}
