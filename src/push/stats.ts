import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { jsonError, parseBody } from "../http";
import type { Category } from "./types";

/** A new stats row for a push going out at `sendAt`; its id travels in the push as `data.pushId`. */
export async function createPushStats(
  db: D1Database,
  category: Category,
  sendAt: number,
): Promise<number> {
  const id = await db
    .prepare("INSERT INTO push_stats (category, send_at) VALUES (?, ?) RETURNING id")
    .bind(category, sendAt)
    .first<number>("id");
  if (id === null) throw new Error("push_stats insert returned no id");
  return id;
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

/** Server routes under /v1/push (API key). */
export const statsRoutes = new Hono<AppEnv>().get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    `SELECT id, category, users, sent, failed, send_at,
       (SELECT count(*) FROM push_open WHERE push_id = ?1) AS opened
     FROM push_stats WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      id: number;
      category: Category;
      users: number;
      sent: number;
      failed: number;
      send_at: number;
      opened: number;
    }>();
  if (!row) return jsonError(404, "not_found", "No such push");
  const { send_at, ...stats } = row;
  return c.json({ ...stats, sendAt: send_at });
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
