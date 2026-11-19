import { type Context, Hono } from "hono";
import type { AppEnv } from "../app";
import { jsonError, parseBody } from "../http";
import { idempotencyKey, runOnce } from "../idempotency";
import { CLAIM_MS, deliverStored } from "../jobs/scheduled";
import { pushStatsInsert, statsRoutes } from "./stats";
import { resolvePush } from "./templates";
import { type PushRequest, PushRequestSchema } from "./types";

async function send(c: Context<AppEnv>, body: PushRequest, now: number): Promise<Response> {
  const { sendAt, ...request } = body;
  const at = sendAt === undefined ? now : Date.parse(sendAt);
  if (sendAt !== undefined && !(at > now)) {
    return jsonError(400, "invalid_body", "sendAt must be in the future");
  }
  const dispatch = await resolvePush(c.env.DB, request);
  if (typeof dispatch === "string") return jsonError(400, "invalid_body", dispatch);
  // An immediate push is stored too, already claimed by this request: if sending it fails, the
  // minute cron sends it once the claim runs out. One batch, so no stats row is left without it.
  const sendAtColumn = sendAt === undefined ? now + CLAIM_MS : at;
  const [stats, row] = await c.env.DB.batch<{ id: number }>([
    pushStatsInsert(c.env.DB, dispatch.category, at),
    c.env.DB.prepare(
      `INSERT INTO scheduled_push (send_at, request, push_id)
       VALUES (?, ?, last_insert_rowid()) RETURNING id`,
    ).bind(sendAtColumn, JSON.stringify(dispatch)),
  ]);
  const id = stats?.results[0]?.id;
  const rowId = row?.results[0]?.id;
  if (id === undefined || rowId === undefined) throw new Error("push insert returned no id");
  if (sendAt !== undefined) return c.json({ id, scheduled: true }, 202);

  try {
    const sent = await deliverStored(
      c.env,
      { id: rowId, request: dispatch, pushId: id, claimed: sendAtColumn },
      now,
    );
    if (sent) return c.json({ id, ...sent }, 202);
  } catch (error) {
    console.error({ event: "push_dispatch_deferred", id, error: String(error) });
  }
  return c.json({ id, scheduled: true }, 202);
}

export const pushRoutes = new Hono<AppEnv>()
  .post("/", async (c) => {
    const key = idempotencyKey(c.req.header("idempotency-key"));
    if (key instanceof Response) return key;
    const body = await parseBody(c, PushRequestSchema);
    if (body instanceof Response) return body;
    const now = Date.now();
    if (key === undefined) return send(c, body, now);
    // A client that retries after a timeout never sends the push twice.
    return runOnce(c.env.DB, { key, body, now, okStatus: 202, scope: "push" }, () =>
      send(c, body, now),
    );
  })
  .route("/", statsRoutes);
