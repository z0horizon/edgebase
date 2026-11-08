import { Hono } from "hono";
import { jsonError } from "./http";

/** Replaced by Better Auth's session user once auth is wired. */
export type SessionUser = { id: string; createdAt: Date };

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

export const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true }));

app.notFound(() => jsonError(404, "not_found", "Route not found"));

app.onError((error) => {
  console.error(error);
  return jsonError(500, "internal", "Internal error");
});
