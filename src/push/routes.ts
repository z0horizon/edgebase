import { Hono } from "hono";
import type { AppEnv } from "../app";
import { jsonError, parseBody } from "../http";
import { dispatchPush } from "./dispatch";
import { PushRequestSchema } from "./types";

export const pushRoutes = new Hono<AppEnv>().post("/", async (c) => {
  const body = await parseBody(c, PushRequestSchema);
  if (body instanceof Response) return body;
  const now = Date.now();
  const { sendAt, ...dispatch } = body;

  if (sendAt !== undefined) {
    const at = Date.parse(sendAt);
    if (!(at > now)) return jsonError(400, "invalid_body", "sendAt must be in the future");
    await c.env.DB.prepare("INSERT INTO scheduled_push (send_at, request) VALUES (?, ?)")
      .bind(at, JSON.stringify(dispatch))
      .run();
    return c.json({ scheduled: true }, 202);
  }

  return c.json(await dispatchPush(c.env, dispatch, now), 202);
});
