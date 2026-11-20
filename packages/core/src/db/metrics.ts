import { type DbName, queryName } from "./registry";

/**
 * D1 metrics per query name: a sampled invocation runs with its D1 bindings wrapped, adds up
 * what each statement cost, and logs one line at the end:
 *   { event: "d1", via, path?, queries: { "<name>": { calls, rowsRead, rowsWritten, ms } } }
 * Statements EdgeBase did not register (Better Auth's) are named `other:<verb>.<table>`.
 * Unsampled invocations use the bindings as they are, at no cost.
 */

/** Share of invocations measured; logs are sampled again by `observability.head_sampling_rate`. */
export const D1_METRICS_SAMPLE_RATE = 0.1;

type Totals = { calls: number; rowsRead: number; rowsWritten: number; ms: number };
export type D1Metrics = Map<string, Totals>;

const DB_NAMES: DbName[] = ["DB", "INBOX_DB"];

/** A name for SQL nobody registered, from its verb and first table: `other:select.session`. */
export function otherName(text: string): string {
  const verb = /\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i.exec(text)?.[1]?.toUpperCase();
  if (!verb) return `other:${/^\s*(\w+)/.exec(text)?.[1]?.toLowerCase() ?? "sql"}`;
  const tableAfter =
    verb === "UPDATE" ? "UPDATE" : verb === "SELECT" || verb === "DELETE" ? "FROM" : "INTO";
  const table = new RegExp(`\\b${tableAfter}\\s+["\`]?(\\w+)`, "i").exec(text)?.[1];
  return `other:${verb.toLowerCase()}${table ? `.${table}` : ""}`;
}

const nameOf = (text: string) => queryName(text) ?? otherName(text);

function add(metrics: D1Metrics, name: string, meta: D1Meta | undefined, ms: number): void {
  const t = metrics.get(name) ?? { calls: 0, rowsRead: 0, rowsWritten: 0, ms: 0 };
  t.calls++;
  t.rowsRead += meta?.rows_read ?? 0;
  t.rowsWritten += meta?.rows_written ?? 0;
  t.ms += meta?.duration ?? ms;
  metrics.set(name, t);
}

/** The real statement and its name behind a wrapped one, for batch(). */
const inner = new WeakMap<object, { stmt: D1PreparedStatement; name: string }>();

function wrapStatement(stmt: D1PreparedStatement, name: string, metrics: D1Metrics) {
  const timed = async <T extends D1Result | D1Result[]>(run: () => Promise<T>) => {
    const started = Date.now();
    const result = await run();
    const meta = Array.isArray(result) ? undefined : result.meta;
    add(metrics, name, meta, Date.now() - started);
    return result;
  };
  const wrapped: D1PreparedStatement = {
    bind: (...values: unknown[]) => wrapStatement(stmt.bind(...values), name, metrics),
    run: <T>() => timed(() => stmt.run<T>()),
    all: <T>() => timed(() => stmt.all<T>()),
    // first() hides meta; all() of a one-row statement reads the same rows and returns them.
    first: (async (column?: string) => {
      const result = await timed(() => stmt.all<Record<string, unknown>>());
      const row = result.results[0];
      if (row === undefined) return null;
      if (column === undefined) return row;
      if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
      return row[column];
    }) as D1PreparedStatement["first"],
    raw: ((options?: { columnNames?: boolean }) => {
      const started = Date.now();
      return stmt.raw(options as { columnNames: true }).then((rows) => {
        add(metrics, name, undefined, Date.now() - started);
        return rows;
      });
    }) as D1PreparedStatement["raw"],
  } as D1PreparedStatement;
  inner.set(wrapped, { stmt, name });
  return wrapped;
}

function wrapDatabase(db: D1Database, metrics: D1Metrics): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (text: string) => wrapStatement(target.prepare(text), nameOf(text), metrics);
      }
      if (prop === "batch") {
        return async <T>(statements: D1PreparedStatement[]) => {
          const real = statements.map((s) => inner.get(s) ?? { stmt: s, name: "other:batch" });
          const started = Date.now();
          const results = await target.batch<T>(real.map((r) => r.stmt));
          const each = (Date.now() - started) / Math.max(1, results.length);
          for (const [i, r] of results.entries()) {
            add(metrics, real[i]?.name ?? "other:batch", r.meta, each);
          }
          return results;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The part of an ExecutionContext `metered` needs: work it may leave running. */
type Deferrable = { waitUntil(promise: Promise<unknown>): void };

/**
 * Runs `work` with D1 measured when `sample` is true, then logs the totals; `via` and `path` say
 * what the invocation was. With `ctx`, work passed to its `waitUntil` (session activity after a
 * response) is counted too: `work` gets a context whose `waitUntil` is followed, and the line is
 * logged once that work has settled, without holding the response.
 */
export async function metered<R, C extends Deferrable = Deferrable>(
  env: Env,
  sample: boolean,
  label: { via: string; path?: string },
  work: (env: Env, ctx: C | undefined) => Promise<R>,
  ctx?: C,
): Promise<R> {
  if (!sample) return work(env, ctx);
  const metrics: D1Metrics = new Map();
  const wrapped = { ...env } as Env;
  for (const name of DB_NAMES) wrapped[name] = wrapDatabase(env[name], metrics);
  const pending: Promise<unknown>[] = [];
  const followed = ctx
    ? new Proxy(ctx, {
        get(target, prop, receiver) {
          if (prop === "waitUntil") {
            return (promise: Promise<unknown>) => {
              pending.push(promise);
              target.waitUntil(promise);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : undefined;
  const log = () => {
    if (metrics.size > 0) {
      console.info({ event: "d1", ...label, queries: Object.fromEntries(metrics) });
    }
  };
  try {
    return await work(wrapped, followed);
  } finally {
    if (ctx) {
      // Deferred work can defer more; the line waits until nothing is left.
      const drain = async () => {
        while (pending.length > 0) await Promise.allSettled(pending.splice(0));
        log();
      };
      ctx.waitUntil(drain());
    } else {
      log();
    }
  }
}

/** Whether this invocation is measured. */
export const sampled = (rate = D1_METRICS_SAMPLE_RATE) => Math.random() < rate;
