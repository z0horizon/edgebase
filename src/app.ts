import { Hono } from "hono";
import { appCallback } from "./auth/app-callback";
import { createAuth, type SessionUser } from "./auth/auth";
import { authRateLimit, requireApiKey, requireAuthConfig, requireUser } from "./auth/middleware";
import { jsonError } from "./http";
import { inboxRoutes } from "./inbox/routes";
import { deviceRoutes } from "./push/devices";
import { pushRoutes } from "./push/routes";

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

// User routes take a session; /v1/push takes the server API key instead.
for (const path of ["/v1/me", "/v1/auth/*", "/v1/devices/*", "/v1/inbox/*"]) {
  app.use(path, requireUser);
}
app.use("/v1/push", requireApiKey);
app.route("/v1/push", pushRoutes);
app.get("/v1/me", (c) => c.json(c.get("user")));
app.get("/v1/auth/app-callback", appCallback);
app.route("/v1/devices", deviceRoutes);
app.route("/v1/inbox", inboxRoutes);

app.notFound(() => jsonError(404, "not_found", "Route not found"));

app.onError((error) => {
  console.error(error);
  return jsonError(500, "internal", "Internal error");
});
