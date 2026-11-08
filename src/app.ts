import { Hono } from "hono";
import { appCallback } from "./auth/app-callback";
import { createAuth, type SessionUser } from "./auth/auth";
import { authRateLimit, requireAuthConfig, requireUser } from "./auth/middleware";
import { jsonError } from "./http";

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

export const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true }));

app.use("/api/auth/*", requireAuthConfig);
app.on(
  "POST",
  [
    "/api/auth/sign-in/*",
    "/api/auth/sign-up/*",
    "/api/auth/request-password-reset",
    "/api/auth/forget-password",
  ],
  authRateLimit,
);
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));

app.use("/v1/*", requireUser);
app.get("/v1/me", (c) => c.json(c.get("user")));
app.get("/v1/auth/app-callback", appCallback);

app.notFound(() => jsonError(404, "not_found", "Route not found"));

app.onError((error) => {
  console.error(error);
  return jsonError(500, "internal", "Internal error");
});
