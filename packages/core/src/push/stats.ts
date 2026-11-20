import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { jsonError, parseBody } from "../http";
import {
  addDeliveries,
  deleteUserOpensStmts,
  getPushStats,
  listPushStats,
  recordOpensStmt,
} from "./queries";

export { pushStatsInsert } from "./queries";

/**
 * Flushes aggregated FCM delivery counts for a consumer batch in one D1 call (one UPDATE per
 * distinct pushId). Runs after sends and acks, so errors are logged rather than redelivering.
 */
export async function recordDeliveries(
  db: D1Database,
  totals: ReadonlyMap<number, { sent: number; failed: number }>,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const [pushId, { sent, failed }] of totals) {
    if (!pushId || (sent === 0 && failed === 0)) continue;
    statements.push(addDeliveries(db, pushId, sent, failed));
  }
  if (statements.length === 0) return;
  try {
    if (statements.length === 1) await statements[0]?.run();
    else await db.batch(statements);
  } catch (error) {
    console.error({
      event: "push_stats_update_failed",
      pushes: statements.length,
      error: String(error),
    });
  }
}

export async function deleteUserOpens(db: D1Database, userId: string): Promise<void> {
  await db.batch(deleteUserOpensStmts(db, userId));
}

/** Server routes under /v1/push (API key). */
export const statsRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await listPushStats(c.env.DB).all();
    return c.json({ pushes: rows.results });
  })
  .get("/:id{[0-9]+}", async (c) => {
    const row = await getPushStats(c.env.DB, Number(c.req.param("id"))).first();
    return row ? c.json(row) : jsonError(404, "not_found", "No such push");
  });

export const PushIdSchema = v.pipe(v.string(), v.regex(/^\d{1,15}$/));
const OpenSchema = v.object({ pushId: PushIdSchema });

/** Counts `userId` once per push opened; ids of pruned or unknown pushes write nothing. */
export async function recordOpens(db: D1Database, userId: string, pushIds: string[]) {
  if (pushIds.length === 0) return;
  await recordOpensStmt(db, userId, pushIds).run();
}

/** User route: the app reports that its user opened a push, passing the push's `data.pushId`. */
export const openRoutes = new Hono<AppEnv>().post("/", async (c) => {
  const body = await parseBody(c, OpenSchema);
  if (body instanceof Response) return body;
  await recordOpens(c.env.DB, c.get("user").id, [body.pushId]);
  return c.body(null, 204);
});
