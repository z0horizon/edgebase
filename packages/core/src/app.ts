import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { appCallback, appExchange } from "./auth/app-callback";
import {
  adminNeedsTwoFactor,
  configuredProviders,
  createAuth,
  emailPasswordEnabled,
  type Session,
  type SessionUser,
  webTrustedOrigins,
} from "./auth/auth";
import {
  authRateLimit,
  requireAdminConsole,
  requireApiKey,
  requireAuthConfig,
  requireUser,
  topicRateLimit,
  userRateLimit,
} from "./auth/middleware";
import {
  adminSessionRoutes,
  sessionSecurityRoutes,
  trustedDeviceRoutes,
} from "./auth/security-routes";
import { SET_TRUST_DEVICE_HEADER, TRUST_DEVICE_HEADER } from "./auth/trusted-devices";
import { appName } from "./config";
import { jsonError } from "./http";
import { inboxRoutes } from "./inbox/routes";
import { deviceRoutes } from "./push/devices";
import { pushRoutes } from "./push/routes";
import { openRoutes } from "./push/stats";
import { templateRoutes } from "./push/templates";
import { topicRoutes } from "./push/topics";

const MAX_BODY_BYTES = 64 * 1024;

/** Better Auth routes that need a password or send account mail; EMAIL_PASSWORD=off closes them. */
const EMAIL_PASSWORD_ROUTES = [
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
  "/api/auth/reset-password/*",
  "/api/auth/change-password",
  "/api/auth/send-verification-email",
];

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; session: Session["session"] };
};

export const app = new Hono<AppEnv>();

// Web apps on another origin call the API with cookies; only TRUSTED_ORIGINS web entries qualify.
app.use("*", (c, next) =>
  cors({
    origin: (origin) => (webTrustedOrigins(c.env).includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization", "x-captcha-response", TRUST_DEVICE_HEADER],
    exposeHeaders: ["set-auth-token", SET_TRUST_DEVICE_HEADER],
    maxAge: 600,
  })(c, next),
);

// Rejects oversized request bodies early before JSON buffering into the 128 MB Worker isolate.
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => jsonError(413, "payload_too_large", "Request body too large"),
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

app.use("/api/auth/*", requireAuthConfig);
app.use("/v1/auth/*", requireAuthConfig);
// Better Auth checks its `enabled` flag only on sign-in and sign-up; reset and verification would
// still send mail, and a reset would give a social account a password. Off means all of them 404.
app.on(["GET", "POST"], EMAIL_PASSWORD_ROUTES, async (c, next) => {
  if (!emailPasswordEnabled(c.env)) return jsonError(404, "not_found", "Route not found");
  await next();
});
app.on(
  "POST",
  [
    "/api/auth/sign-in/*",
    "/api/auth/sign-up/*",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/change-password",
    "/api/auth/verify-password",
    "/api/auth/delete-user",
    "/api/auth/link-social",
    "/api/auth/unlink-account",
    "/api/auth/send-verification-email",
    // Six-digit codes: without a limit they are guessed in minutes.
    "/api/auth/two-factor/*",
    // Sends mail to any address, with text the inviter chooses.
    "/api/auth/organization/invite-member",
    "/v1/auth/app-exchange",
  ],
  authRateLimit,
);
// Passkey ceremony option generators are GETs that write challenges to `verification`; guard both GET and POST.
app.on(
  ["GET", "POST"],
  [
    "/api/auth/passkey/generate-register-options",
    "/api/auth/passkey/generate-authenticate-options",
    "/api/auth/passkey/verify-registration",
    "/api/auth/passkey/verify-authentication",
  ],
  authRateLimit,
);
// Native apps redeem one-time tokens only through /v1/auth/app-exchange, which checks the verifier.
app.post("/api/auth/one-time-token/verify", () => jsonError(404, "not_found", "Route not found"));
// Better Auth's session list and provider token endpoints expose raw bearer/OAuth secrets;
// callers use token-free `/v1/sessions` and `/v1/admin/users/:userId/sessions` instead.
app.get("/api/auth/list-sessions", () => jsonError(404, "not_found", "Route not found"));
app.post("/api/auth/admin/list-user-sessions", () =>
  jsonError(404, "not_found", "Route not found"),
);
app.post("/api/auth/get-access-token", () => jsonError(404, "not_found", "Route not found"));
app.post("/api/auth/refresh-token", () => jsonError(404, "not_found", "Route not found"));
app.get("/api/auth/account-info", () => jsonError(404, "not_found", "Route not found"));
app.on(["GET", "POST"], "/api/auth/*", (c) =>
  createAuth(c.env, c.executionCtx, c.req.raw).handler(c.req.raw),
);

// User routes take a session; /v1/push takes the server API key instead.
// app-callback checks its own session so it can redirect failures back to the app.
for (const path of [
  "/v1/me",
  "/v1/sessions",
  "/v1/sessions/*",
  "/v1/trusted-devices",
  "/v1/trusted-devices/*",
  "/v1/admin/*",
  "/v1/devices/*",
  "/v1/inbox/*",
  "/v1/opens",
  "/v1/topics/*",
]) {
  app.use(path, requireAuthConfig, requireUser);
  // Admin routes are 2FA-gated and the admin page pages through users; they are not limited per user.
  if (path !== "/v1/admin/*") app.use(path, userRateLimit);
}
app.use("/v1/admin/*", requireAdminConsole);
// Each topic change is one Instance ID request against the project's quota.
app.use("/v1/topics/*", topicRateLimit);
for (const path of ["/v1/push/*", "/v1/templates/*"]) app.use(path, requireApiKey);
app.route("/v1/push", pushRoutes);
app.route("/v1/templates", templateRoutes);
app.route("/v1/opens", openRoutes);
app.route("/v1/topics", topicRoutes);
// The admin page reads the two-factor rule from here instead of keeping its own copy.
app.get("/v1/me", (c) => {
  const user = c.get("user");
  return c.json({
    ...user,
    adminNeedsTwoFactor: adminNeedsTwoFactor({ user, session: c.get("session") }),
  });
});
// The admin page names the product and shows only the providers whose credentials are set, and
// the password form only when it is on.
app.get("/v1/auth/providers", (c) =>
  c.json({
    appName: appName(c.env),
    providers: Object.keys(configuredProviders(c.env)),
    emailPassword: emailPasswordEnabled(c.env),
    turnstileRequired: Boolean(c.env.TURNSTILE_SECRET_KEY?.trim()),
  }),
);
app.get("/v1/auth/app-callback", appCallback);
app.post("/v1/auth/app-exchange", appExchange);
app.route("/v1/sessions", sessionSecurityRoutes);
app.route("/v1/trusted-devices", trustedDeviceRoutes);
app.route("/v1/admin/users", adminSessionRoutes);
app.route("/v1/devices", deviceRoutes);
app.route("/v1/inbox", inboxRoutes);

app.notFound(() => jsonError(404, "not_found", "Route not found"));

app.onError((error, c) => {
  console.error({
    event: "unhandled_error",
    method: c.req.method,
    path: c.req.path,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return jsonError(500, "internal", "Internal error");
});
