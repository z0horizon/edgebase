import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import { jsonError } from "../http";
import { createAuth } from "./auth";

const notConfigured = () => jsonError(503, "not_configured", "Sign-in is not configured");

/** Blocks every auth route while the auth secret is unset, instead of running with a blank key. */
export const requireAuthConfig: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.BETTER_AUTH_SECRET?.trim()) return notConfigured();
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.BETTER_AUTH_SECRET?.trim()) return notConfigured();
  const session = await createAuth(c.env, c.executionCtx).api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return jsonError(401, "unauthorized", "Sign in first");
  c.set("user", session.user);
  await next();
};

export const authRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.AUTH_RL.limit({ key })).success) {
    return jsonError(429, "rate_limited", "Too many attempts, try again in a minute");
  }
  await next();
};

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Server-to-server key for sending pushes; digests make the compare constant-time at equal length. */
export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.PUSH_API_KEY?.trim();
  if (!expected || !c.env.FCM_SERVICE_ACCOUNT?.trim()) {
    return jsonError(503, "not_configured", "Push is not configured");
  }
  const [given, wanted] = await Promise.all([
    sha256(c.req.header("x-api-key") ?? ""),
    sha256(expected),
  ]);
  if (!crypto.subtle.timingSafeEqual(given, wanted)) {
    return jsonError(401, "unauthorized", "Invalid API key");
  }
  await next();
};
