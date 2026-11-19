import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { jsonError, parseBody } from "../http";
import { STATS_LISTED } from "./limits";
import type { Category } from "./types";

/** A new stats row for a push going out at `sendAt`; its id travels in the push as `data.pushId`. */
export function pushStatsInsert(db: D1Database, category: Category, sendAt: number) {
  return db
    .prepare("INSERT INTO push_stats (category, send_at) VALUES (?, ?) RETURNING id")
    .bind(category, sendAt);
}

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
    statements.push(
      db
        .prepare("UPDATE push_stats SET sent = sent + ?, failed = failed + ? WHERE id = ?")
        .bind(sent, failed, pushId),
    );
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
  await db.batch([
    db
      .prepare(
        `UPDATE push_stats SET opened = MAX(0, opened - 1)
         WHERE id IN (SELECT push_id FROM push_open WHERE user_id = ?)`,
      )
      .bind(userId),
    db.prepare("DELETE FROM push_open WHERE user_id = ?").bind(userId),
  ]);
}

const STATS_COLUMNS = "id, category, users, sent, failed, opened, send_at AS sendAt";

/** Server routes under /v1/push (API key). */
export const statsRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT ${STATS_COLUMNS} FROM push_stats ORDER BY id DESC LIMIT ${STATS_LISTED}`,
    ).all();
    return c.json({ pushes: rows.results });
  })
  .get("/:id{[0-9]+}", async (c) => {
    const row = await c.env.DB.prepare(`SELECT ${STATS_COLUMNS} FROM push_stats WHERE id = ?`)
      .bind(Number(c.req.param("id")))
      .first();
    return row ? c.json(row) : jsonError(404, "not_found", "No such push");
  });

export const PushIdSchema = v.pipe(v.string(), v.regex(/^\d{1,15}$/));
const OpenSchema = v.object({ pushId: PushIdSchema });

/** Counts `userId` once per push opened; ids of pruned or unknown pushes write nothing. */
export async function recordOpens(db: D1Database, userId: string, pushIds: string[]) {
  if (pushIds.length === 0) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO push_open (push_id, user_id)
       SELECT id, ?2 FROM push_stats WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?1))`,
    )
    .bind(JSON.stringify(pushIds), userId)
    .run();
}

/** User route: the app reports that its user opened a push, passing the push's `data.pushId`. */
export const openRoutes = new Hono<AppEnv>().post("/", async (c) => {
  const body = await parseBody(c, OpenSchema);
  if (body instanceof Response) return body;
  await recordOpens(c.env.DB, c.get("user").id, [body.pushId]);
  return c.body(null, 204);
});
