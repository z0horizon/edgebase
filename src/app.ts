import { Hono } from "hono";
import { cors } from "hono/cors";
import { appCallback, appExchange } from "./auth/app-callback";
import { createAuth, type SessionUser } from "./auth/auth";
import {
  authRateLimit,
  requireApiKey,
  requireAuthConfig,
  requireUser,
  topicRateLimit,
} from "./auth/middleware";
import { jsonError } from "./http";
import { inboxRoutes } from "./inbox/routes";
import { deviceRoutes } from "./push/devices";
import { pushRoutes } from "./push/routes";
import { openRoutes } from "./push/stats";
import { templateRoutes } from "./push/templates";
import { topicRoutes } from "./push/topics";

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
    allowHeaders: ["content-type", "authorization", "x-captcha-response"],
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
    "/api/auth/send-verification-email",
    // Six-digit codes: without a limit they are guessed in minutes.
    "/api/auth/two-factor/*",
    // Sends mail to any address, with text the inviter chooses.
    "/api/auth/organization/invite-member",
    "/v1/auth/app-exchange",
  ],
  authRateLimit,
);
// Native apps redeem one-time tokens only through /v1/auth/app-exchange, which checks the verifier.
app.post("/api/auth/one-time-token/verify", () => jsonError(404, "not_found", "Route not found"));
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));

// User routes take a session; /v1/push takes the server API key instead.
// app-callback checks its own session so it can redirect failures back to the app.
for (const path of ["/v1/me", "/v1/devices/*", "/v1/inbox/*", "/v1/opens", "/v1/topics/*"]) {
  app.use(path, requireAuthConfig, requireUser);
}
// Each topic change is one Instance ID request against the project's quota.
app.use("/v1/topics/*", topicRateLimit);
for (const path of ["/v1/push/*", "/v1/templates/*"]) app.use(path, requireApiKey);
app.route("/v1/push", pushRoutes);
app.route("/v1/templates", templateRoutes);
app.route("/v1/opens", openRoutes);
app.route("/v1/topics", topicRoutes);
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
