import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { parseBody } from "../http";
import { type Platform, PlatformSchema } from "./types";

const REFRESH_MS = 7 * 86_400_000;
const MAX_DEVICES = 10;

/**
 * Apps call this on every launch; the WHERE clause turns most of those calls into zero writes,
 * touching the row only when the owner or platform changed or it is a week old.
 */
export async function upsertDevice(
  db: D1Database,
  d: { token: string; userId: string; platform: Platform },
  now: number,
): Promise<{ written: boolean }> {
  const result = await db
    .prepare(
      `INSERT INTO device (token, user_id, platform, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(token) DO UPDATE SET
         user_id = excluded.user_id, platform = excluded.platform, updated_at = excluded.updated_at
       WHERE device.user_id <> excluded.user_id OR device.platform <> excluded.platform
          OR excluded.updated_at - device.updated_at >= ?5`,
    )
    .bind(d.token, d.userId, d.platform, now, REFRESH_MS)
    .run();
  const written = result.meta.changes > 0;
  if (written) {
    await db
      .prepare(
        `DELETE FROM device WHERE user_id = ?1 AND token NOT IN
           (SELECT token FROM device WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT ?2)`,
      )
      .bind(d.userId, MAX_DEVICES)
      .run();
  }
  return { written };
}

const DeviceSchema = v.object({
  token: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  platform: PlatformSchema,
});

export const deviceRoutes = new Hono<AppEnv>()
  .put("/", async (c) => {
    const body = await parseBody(c, DeviceSchema);
    if (body instanceof Response) return body;
    await upsertDevice(c.env.DB, { ...body, userId: c.get("user").id }, Date.now());
    return c.body(null, 204);
  })
  .delete("/:token", async (c) => {
    await c.env.DB.prepare("DELETE FROM device WHERE token = ? AND user_id = ?")
      .bind(c.req.param("token"), c.get("user").id)
      .run();
    return c.body(null, 204);
  });
