import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import { base64url, jsonError, sha256 } from "../http";
import { adminNeedsTwoFactor, createAuth, webTrustedOrigins } from "./auth";
import { normalizeRateLimitIp } from "./network";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isAllowedWebOrigin(env: Env, origin: string | undefined): boolean {
  if (!origin) return false;
  return origin === new URL(env.BASE_URL).origin || webTrustedOrigins(env).includes(origin);
}

/** Blocks every auth route while the auth secret is unset, instead of running with a blank key. */
export const requireAuthConfig: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.BETTER_AUTH_SECRET?.trim()) {
    return jsonError(503, "not_configured", "Sign-in is not configured");
  }
  await next();
};

/** Use after requireAuthConfig. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Cookie-authenticated mutations must come from the Worker's own origin or a web TRUSTED_ORIGINS
  // entry so a sibling subdomain sharing SameSite=Lax cookies cannot forge state-changing calls.
  if (
    !SAFE_METHODS.has(c.req.method) &&
    c.req.header("authorization") === undefined &&
    c.req.header("cookie") !== undefined &&
    !isAllowedWebOrigin(c.env, c.req.header("origin"))
  ) {
    return jsonError(403, "forbidden_origin", "Untrusted request origin");
  }

  const session = await createAuth(c.env, c.executionCtx, c.req.raw).api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return jsonError(401, "unauthorized", "Sign in first");
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
};

/** Every limit counts over 60 s, so Retry-After tells a client when it can be sure to get through. */
function rateLimited(message: string): Response {
  const res = jsonError(429, "rate_limited", message);
  res.headers.set("retry-after", "60");
  return res;
}

export const authRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = normalizeRateLimitIp(c.req.header("cf-connecting-ip"));
  if (!(await c.env.AUTH_RL.limit({ key })).success) {
    return rateLimited("Too many attempts, try again in a minute");
  }
  await next();
};

/**
 * Use after authRateLimit on routes whose JSON body names an `email`: AUTH_RL stops one machine,
 * this stops many machines working on one address (password guessing, repeated reset or
 * verification mail). A body without a usable email is left to the route's own validation.
 */
export const emailRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => null);
  const email =
    typeof body === "object" && body !== null && "email" in body && typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
  // The key is a digest: a rate-limit key is capped in length and should not hold an address.
  if (
    email !== "" &&
    !(await c.env.EMAIL_RL.limit({ key: base64url(await sha256(email)) })).success
  ) {
    return rateLimited("Too many attempts for this email, try again in a minute");
  }
  await next();
};

/**
 * Use after requireUser on signed-in routes: every call counts against USER_RL, and calls that can
 * write (anything but GET/HEAD/OPTIONS) also against USER_WRITE_RL, keyed by user id. The limits sit
 * far above what an app does (it marks inbox items read one call at a time while scrolling), and
 * bound what one account can cost: a write loop on PUT /v1/devices stays near 360 row writes a
 * minute. Admins are not limited: the admin page reads a failed /v1/me as signed out.
 */
export const userRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (user.role === "admin") return next();
  const writes = !SAFE_METHODS.has(c.req.method);
  if (
    !(await c.env.USER_RL.limit({ key: user.id })).success ||
    (writes && !(await c.env.USER_WRITE_RL.limit({ key: user.id })).success)
  ) {
    return rateLimited("Too many requests, try again in a minute");
  }
  await next();
};

/** Use after requireUser: keyed by user, so it never shares a budget with sign-in per IP. */
export const topicRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await c.env.TOPIC_RL.limit({ key: c.get("user").id })).success) {
    return rateLimited("Too many topic changes, try again in a minute");
  }
  await next();
};

const twoFactorRequired = () =>
  jsonError(403, "two_factor_required", "Turn on two-factor authentication to use admin features");

/** Use after requireUser on `/v1/admin/*`: requires `role === "admin"` and 2FA rule satisfied. */
export const requireAdminConsole: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  const session = c.get("session");
  if (user.role !== "admin") return jsonError(403, "forbidden", "Admin role required");
  if (adminNeedsTwoFactor({ user, session })) return twoFactorRequired();
  await next();
};

/**
 * Server-to-server key for sending pushes; digests make the compare constant-time at equal length.
 * Without the header, a session of an admin from the Worker's own origin (the /admin page) is
 * accepted instead; the Origin check keeps other sites from riding that cookie.
 */
export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.PUSH_API_KEY?.trim();
  if (!expected || !c.env.FCM_SERVICE_ACCOUNT?.trim()) {
    return jsonError(503, "not_configured", "Push is not configured");
  }
  if (c.req.header("x-api-key") === undefined && c.env.BETTER_AUTH_SECRET?.trim()) {
    // Browsers send Origin on every cross-origin fetch and on same-origin writes; only same-origin GETs may omit it.
    const origin = c.req.header("origin");
    const sameOrigin =
      origin === undefined ? c.req.method === "GET" : origin === new URL(c.env.BASE_URL).origin;
    const session = sameOrigin
      ? await createAuth(c.env, c.executionCtx, c.req.raw).api.getSession({
          headers: c.req.raw.headers,
        })
      : null;
    if (session?.user.role !== "admin") return jsonError(401, "unauthorized", "Invalid API key");
    if (adminNeedsTwoFactor(session)) return twoFactorRequired();
    await next();
    return;
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
