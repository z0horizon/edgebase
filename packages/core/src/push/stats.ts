import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { jsonError, parseBody } from "../http";
import { STATS_LISTED } from "./limits";
import type { Category } from "./types";

/** A new stats row for a push going out at `sendAt`; its id travels in the push as `data.pushId`. */
export async function createPushStats(
  db: D1Database,
  category: Category,
  sendAt: number,
): Promise<number> {
  const id = await pushStatsInsert(db, category, sendAt).first<number>("id");
  if (id === null) throw new Error("push_stats insert returned no id");
  return id;
}

/** The insert of `createPushStats`, for a batch whose next statement reads `last_insert_rowid()`. */
export function pushStatsInsert(db: D1Database, category: Category, sendAt: number) {
  return db
    .prepare("INSERT INTO push_stats (category, send_at) VALUES (?, ?) RETURNING id")
    .bind(category, sendAt);
}

/**
 * FCM's answers for one queue message: accepted, and finally refused or out of retries. It runs
 * after the sends, so it logs instead of throwing: a throw would make Queues send them again.
 */
export async function recordDelivery(
  db: D1Database,
  pushId: number,
  sent: number,
  failed: number,
): Promise<void> {
  if (!pushId || (sent === 0 && failed === 0)) return;
  try {
    await db
      .prepare("UPDATE push_stats SET sent = sent + ?, failed = failed + ? WHERE id = ?")
      .bind(sent, failed, pushId)
      .run();
  } catch (error) {
    console.error("push stats update failed", { pushId, sent, failed, error: String(error) });
  }
}

export async function deleteUserOpens(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM push_open WHERE user_id = ?").bind(userId).run();
}

const STATS_COLUMNS = `id, category, users, sent, failed, send_at AS sendAt,
  (SELECT count(*) FROM push_open WHERE push_id = push_stats.id) AS opened`;

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

const OpenSchema = v.object({ pushId: v.pipe(v.string(), v.regex(/^\d{1,15}$/)) });

/** User route: the app reports that its user opened a push, passing the push's `data.pushId`. */
export const openRoutes = new Hono<AppEnv>().post("/", async (c) => {
  const body = await parseBody(c, OpenSchema);
  if (body instanceof Response) return body;
  // Each user counts once per push; ids of pruned or unknown pushes write nothing.
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO push_open (push_id, user_id)
     SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM push_stats WHERE id = ?1)`,
  )
    .bind(Number(body.pushId), c.get("user").id)
    .run();
  return c.body(null, 204);
});
