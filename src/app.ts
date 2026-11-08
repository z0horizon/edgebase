import { Hono } from "hono";
import { cors } from "hono/cors";
import { appCallback, appExchange } from "./auth/app-callback";
import { createAuth, type SessionUser } from "./auth/auth";
import { authRateLimit, requireApiKey, requireAuthConfig, requireUser } from "./auth/middleware";
import { jsonError } from "./http";
import { inboxRoutes } from "./inbox/routes";
import { deviceRoutes } from "./push/devices";
import { pushRoutes } from "./push/routes";

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

export const app = new Hono<AppEnv>();

// Web apps on another origin call the API with cookies; only TRUSTED_ORIGINS web entries qualify.
app.use("*", (c, next) =>
  cors({
    origin: (origin) =>
      c.env.TRUSTED_ORIGINS.split(",")
        .map((o) => o.trim())
        .filter((o) => o.startsWith("https://") || o.startsWith("http://"))
        .includes(origin)
        ? origin
        : null,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization"],
    exposeHeaders: ["set-auth-token"],
    maxAge: 600,
  })(c, next),
);

app.get("/health", (c) => c.json({ ok: true }));

app.use("/api/auth/*", requireAuthConfig);
app.use("/v1/auth/*", requireAuthConfig);
app.on(
  "POST",
  [
    "/api/auth/sign-in/*",
    "/api/auth/sign-up/*",
    "/api/auth/request-password-reset",
    "/api/auth/forget-password",
    "/api/auth/send-verification-email",
    "/v1/auth/app-exchange",
  ],
  authRateLimit,
);
// Native apps redeem one-time tokens only through /v1/auth/app-exchange, which checks the verifier.
app.post("/api/auth/one-time-token/verify", () => jsonError(404, "not_found", "Route not found"));
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));

// User routes take a session; /v1/push takes the server API key instead.
// app-callback checks its own session so it can redirect failures back to the app.
for (const path of ["/v1/me", "/v1/devices/*", "/v1/inbox/*"]) {
  app.use(path, requireAuthConfig, requireUser);
}
app.use("/v1/push", requireApiKey);
app.route("/v1/push", pushRoutes);
app.get("/v1/me", (c) => c.json(c.get("user")));
app.get("/v1/auth/app-callback", appCallback);
app.post("/v1/auth/app-exchange", appExchange);
app.route("/v1/devices", deviceRoutes);
app.route("/v1/inbox", inboxRoutes);

app.notFound(() => jsonError(404, "not_found", "Route not found"));

app.onError((error) => {
  console.error(error);
  return jsonError(500, "internal", "Internal error");
});
