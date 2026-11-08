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
