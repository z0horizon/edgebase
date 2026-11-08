import { type Context, Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { base64url, jsonError, parseBody, sha256 } from "../http";
import { dispatchPush } from "./dispatch";
import { createPushStats, statsRoutes } from "./stats";
import { resolvePush } from "./templates";
import { type PushRequest, PushRequestSchema } from "./types";

const IdempotencyKeySchema = v.pipe(v.string(), v.regex(/^[\x21-\x7e]{1,255}$/));

async function send(c: Context<AppEnv>, body: PushRequest, now: number): Promise<Response> {
  const { sendAt, ...request } = body;
  const at = sendAt === undefined ? now : Date.parse(sendAt);
  if (sendAt !== undefined && !(at > now)) {
    return jsonError(400, "invalid_body", "sendAt must be in the future");
  }
  const dispatch = await resolvePush(c.env.DB, request);
  if (typeof dispatch === "string") return jsonError(400, "invalid_body", dispatch);
  const id = await createPushStats(c.env.DB, dispatch.category, at);

  if (sendAt !== undefined) {
    await c.env.DB.prepare(
      "INSERT INTO scheduled_push (send_at, request, push_id) VALUES (?, ?, ?)",
    )
      .bind(at, JSON.stringify(dispatch), id)
      .run();
    return c.json({ id, scheduled: true }, 202);
  }
  return c.json({ id, ...(await dispatchPush(c.env, dispatch, now, id)) }, 202);
}

/**
 * With an Idempotency-Key, the first request's 202 is stored for 24 h and replayed to every
 * repeat, so a client that retries after a timeout never sends the push twice.
 */
async function sendOnce(
  c: Context<AppEnv>,
  key: string,
  body: PushRequest,
  now: number,
): Promise<Response> {
  const hash = base64url(await sha256(JSON.stringify(body)));
  const claimed = await c.env.DB.prepare(
    `INSERT INTO push_idempotency (key, request_hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  )
    .bind(key, hash, now)
    .run();
  if (claimed.meta.changes === 0) {
    const prior = await c.env.DB.prepare(
      "SELECT request_hash, response FROM push_idempotency WHERE key = ?",
    )
      .bind(key)
      .first<{ request_hash: string; response: string | null }>();
    if (prior && prior.request_hash !== hash) {
      return jsonError(422, "idempotency_mismatch", "Idempotency-Key was used with another body");
    }
    if (!prior?.response) {
      return jsonError(409, "idempotency_in_progress", "A request with this key is still running");
    }
    return new Response(prior.response, {
      status: 202,
      headers: { "content-type": "application/json", "idempotent-replayed": "true" },
    });
  }

  let res: Response;
  try {
    res = await send(c, body, now);
  } catch (error) {
    // Free the key so the client's retry runs instead of waiting out the 24 h.
    await c.env.DB.prepare("DELETE FROM push_idempotency WHERE key = ?").bind(key).run();
    throw error;
  }
  if (res.status === 202) {
    await c.env.DB.prepare("UPDATE push_idempotency SET response = ? WHERE key = ?")
      .bind(await res.clone().text(), key)
      .run();
  } else {
    // A 400 sent nothing; the corrected request may reuse the key.
    await c.env.DB.prepare("DELETE FROM push_idempotency WHERE key = ?").bind(key).run();
  }
  return res;
}

export const pushRoutes = new Hono<AppEnv>()
  .post("/", async (c) => {
    const key = c.req.header("idempotency-key");
    if (key !== undefined && !v.is(IdempotencyKeySchema, key)) {
      return jsonError(400, "invalid_header", "Idempotency-Key must be 1-255 printable characters");
    }
    const body = await parseBody(c, PushRequestSchema);
    if (body instanceof Response) return body;
    const now = Date.now();
    return key === undefined ? send(c, body, now) : sendOnce(c, key, body, now);
  })
  .route("/", statsRoutes);
