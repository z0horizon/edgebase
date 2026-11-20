/**
 * Every SQL statement EdgeBase runs is registered here by name, so that:
 * - a test runs `EXPLAIN QUERY PLAN` on each and fails on a full scan of a real table
 *   (D1 bills rows scanned, not rows returned), and
 * - D1 metrics (db/metrics.ts) report rows read and written per query name.
 * Better Auth's own queries go through its adapter and are not registered.
 */

/** The D1 binding a statement runs on. */
export type DbName = "DB" | "INBOX_DB";

export type QueryEntry = {
  name: string;
  db: DbName;
  sql: string;
  /** Why a full scan of a table is acceptable here, for the plan test (e.g. a tiny table). */
  scanOk?: string;
};

const entries = new Map<string, QueryEntry>();
const nameBySql = new Map<string, string>();
/** Runtime-built variants (a variable number of rows or ids) are named too, up to this many. */
const MAX_NAMED_TEXTS = 2000;

/**
 * Registers a statement and returns its text. Call at module level for fixed SQL; a builder of
 * variable SQL calls it with one sample at module level (so the plan test sees it) and may call
 * it again at runtime with each variant, which only names it for metrics.
 */
export function sql(
  name: string,
  db: DbName,
  text: string,
  opts: { scanOk?: string } = {},
): string {
  if (!entries.has(name)) entries.set(name, { name, db, sql: text, ...opts });
  if (!nameBySql.has(text) && nameBySql.size < MAX_NAMED_TEXTS) nameBySql.set(text, name);
  return text;
}

/** Every registered statement: one sample per name. */
export const registeredQueries = (): QueryEntry[] => [...entries.values()];

/** The name a statement was registered under, or undefined for one EdgeBase did not register. */
export const queryName = (text: string): string | undefined => nameBySql.get(text);
