import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
// Loads every module, which registers every statement EdgeBase runs.
import "../src/index";
import { registeredQueries } from "../src/db/registry";

/** Bound parameters a statement takes: the highest `?NNN`, or the count of bare `?`. */
function paramCount(text: string): number {
  const numbered = [...text.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  const bare = [...text.matchAll(/\?(?!\d)/g)].length;
  return Math.max(bare, ...numbered, 0);
}

/** Alias → table for `FROM t a` and `JOIN t a`, so a plan's `SCAN u` is read as `SCAN user`. */
function aliases(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const keywords = new Set(["where", "join", "left", "on", "order", "group", "limit", "set", "as"]);
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+(\w+)\s+(?:AS\s+)?(\w+)/gi)) {
    const [, table, alias] = m;
    if (table && alias && !keywords.has(alias.toLowerCase())) out.set(alias, table);
  }
  return out;
}

async function tables(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  return new Set(rows.results.map((r) => r.name));
}

describe("query plans", () => {
  it("registers every statement under a unique name with valid SQL", () => {
    const all = registeredQueries();
    expect(all.length).toBeGreaterThan(80);
    expect(new Set(all.map((q) => q.name)).size).toBe(all.length);
  });

  it("never scans a whole table unless the statement says why", async () => {
    const known = { DB: await tables(env.DB), INBOX_DB: await tables(env.INBOX_DB) };
    const scans: string[] = [];
    const unusedExcuses: string[] = [];
    for (const q of registeredQueries()) {
      const db = q.db === "DB" ? env.DB : env.INBOX_DB;
      // Fails on SQL that does not parse or a table that is not in this database.
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .bind(...Array.from({ length: paramCount(q.sql) }, () => null))
        .all<{ detail: string }>();
      const alias = aliases(q.sql);
      const scanned = plan.results
        .map((r) => /^SCAN (\w+)/.exec(r.detail)?.[1])
        .filter((name): name is string => name !== undefined)
        .map((name) => alias.get(name) ?? name)
        .filter((name) => known[q.db].has(name));
      if (scanned.length > 0 && !q.scanOk) scans.push(`${q.name}: SCAN ${scanned.join(", ")}`);
      if (scanned.length === 0 && q.scanOk) unusedExcuses.push(q.name);
    }
    expect(scans).toEqual([]);
    // An excuse that no longer applies hides the next real scan of that statement.
    expect(unusedExcuses).toEqual([]);
  });
});

describe("SQL lives in query modules", () => {
  it("has no SQL literal passed to prepare() outside them", () => {
    const sources = import.meta.glob<string>("../src/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const offenders = Object.entries(sources)
      .filter(([path]) => !/\/queries\.ts$|\/idempotency\.ts$|\/db\//.test(path))
      .filter(([, text]) => /\.prepare\(\s*["'`]/.test(text))
      .map(([path]) => path);
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });
});
