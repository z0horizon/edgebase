import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { parseBody } from "../http";
import { deleteOwnDevice, trimDevices, upsertDeviceStmt } from "./queries";
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
  const result = await upsertDeviceStmt(db, d, now, REFRESH_MS).run();
  const written = result.meta.changes > 0;
  if (written) {
    await trimDevices(db, d.userId, MAX_DEVICES).run();
  }
  return { written };
}

export const DeviceSchema = v.object({
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
    await deleteOwnDevice(c.env.DB, c.req.param("token"), c.get("user").id).run();
    return c.body(null, 204);
  });
