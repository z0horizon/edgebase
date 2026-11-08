import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { jsonError, parseBody } from "../http";
import { getAccessToken } from "./fcm";
import { TopicSchema } from "./types";

const IID_URL = "https://iid.googleapis.com/iid/v1";

type IidResponse = { results?: { error?: string }[] };

/**
 * Adds or removes one token on an FCM topic through the legacy Instance ID API: the web FCM SDK
 * cannot subscribe itself. An empty string is success; otherwise the error to report.
 */
export async function setTopic(
  serviceAccountJson: string,
  token: string,
  topic: string,
  subscribe: boolean,
  now: number,
): Promise<string> {
  const access = await getAccessToken(serviceAccountJson, now);
  const res = await fetch(`${IID_URL}:${subscribe ? "batchAdd" : "batchRemove"}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${access.token}`,
      access_token_auth: "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: `/topics/${topic}`, registration_tokens: [token] }),
  });
  if (!res.ok) return `Instance ID API answered ${res.status}`;
  const body = await res.json<IidResponse>().catch((): IidResponse => ({}));
  return body.results?.[0]?.error ?? "";
}

const TokenSchema = v.object({ token: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) });

const change = (subscribe: boolean) =>
  new Hono<AppEnv>().post("/", async (c) => {
    const topic = c.req.param("topic") ?? "";
    if (!v.is(TopicSchema, topic)) {
      return jsonError(400, "invalid_body", "topic must match [a-zA-Z0-9-_.~%]{1,900}");
    }
    const body = await parseBody(c, TokenSchema);
    if (body instanceof Response) return body;
    if (!c.env.FCM_SERVICE_ACCOUNT?.trim()) {
      return jsonError(503, "not_configured", "Push is not configured");
    }
    // Only a token the caller registered, so nobody subscribes someone else's browser.
    const owned = await c.env.DB.prepare("SELECT 1 FROM device WHERE token = ? AND user_id = ?")
      .bind(body.token, c.get("user").id)
      .first();
    if (!owned) return jsonError(404, "not_found", "No such device of yours");
    const error = await setTopic(
      c.env.FCM_SERVICE_ACCOUNT,
      body.token,
      topic,
      subscribe,
      Date.now(),
    );
    if (error) return jsonError(502, "upstream_error", error);
    return c.body(null, 204);
  });

export const topicRoutes = new Hono<AppEnv>()
  .route("/:topic/subscribe", change(true))
  .route("/:topic/unsubscribe", change(false));
