import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { base64url, jsonError, sha256 } from "../http";
import { SESSION_DELETE_OTHERS, SESSION_DELETE_OWN, SESSION_LIST_ACTIVE } from "./queries";
import {
  extractTrustDeviceToken,
  listTrustedDevices,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  serializeTrustCookie,
  wipeCredentialsState,
} from "./trusted-devices";

const MAX_LISTED_SESSIONS = 50;
const IdParamSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

type SessionListRow = {
  id: string;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  asn: number | null;
  asOrganization: string | null;
  country: string | null;
  city: string | null;
  createdIp: string | null;
  createdAsn: number | null;
  createdAsOrganization: string | null;
  createdCountry: string | null;
  createdCity: string | null;
  lastActiveAt: string | null;
  signInProvider: string | null;
  twoFactorMethod: "totp" | "backup_code" | "trusted_device" | null;
  twoFactorVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

async function queryActiveSessions(
  db: D1Database,
  userId: string,
  nowIso: string,
): Promise<SessionListRow[]> {
  const rows = await db
    .prepare(SESSION_LIST_ACTIVE)
    .bind(userId, nowIso, MAX_LISTED_SESSIONS)
    .all<SessionListRow>();
  return rows.results;
}

/**
 * Self-service active session inspection and revocation. Not gated by the 15-minute `freshAge`
 * window and never exposes raw `session.token` bearer credentials on the wire.
 */
export const sessionSecurityRoutes = new Hono<AppEnv>();

sessionSecurityRoutes.get("/", async (c) => {
  const currentId = c.get("session").id;
  const rows = await queryActiveSessions(c.env.DB, c.get("user").id, new Date().toISOString());
  return c.json({
    sessions: rows.map((s) => ({ ...s, current: s.id === currentId })),
  });
});

sessionSecurityRoutes.post("/revoke-others", async (c) => {
  await c.env.DB.prepare(SESSION_DELETE_OTHERS).bind(c.get("user").id, c.get("session").id).run();
  return c.body(null, 204);
});

sessionSecurityRoutes.delete("/:id", async (c) => {
  const id = v.safeParse(IdParamSchema, c.req.param("id"));
  if (!id.success) return jsonError(400, "invalid_param", "Invalid session id");
  const result = await c.env.DB.prepare(SESSION_DELETE_OWN).bind(id.output, c.get("user").id).run();
  if (result.meta.changes === 0) return jsonError(404, "not_found", "Session not found");
  return c.body(null, 204);
});

/**
 * Token-free admin inspection and revocation of a user's active sessions, preserving the
 * co-admin non-impersonation boundary.
 */
export const adminSessionRoutes = new Hono<AppEnv>();

adminSessionRoutes.get("/:userId/sessions", async (c) => {
  const userId = v.safeParse(IdParamSchema, c.req.param("userId"));
  if (!userId.success) return jsonError(400, "invalid_param", "Invalid user id");
  const currentId = c.get("session").id;
  const rows = await queryActiveSessions(c.env.DB, userId.output, new Date().toISOString());
  return c.json({
    sessions: rows.map((s) => ({ ...s, current: s.id === currentId })),
  });
});

adminSessionRoutes.delete("/:userId/sessions/:sessionId", async (c) => {
  const userId = v.safeParse(IdParamSchema, c.req.param("userId"));
  const sessionId = v.safeParse(IdParamSchema, c.req.param("sessionId"));
  if (!userId.success || !sessionId.success) {
    return jsonError(400, "invalid_param", "Invalid user or session id");
  }
  const result = await c.env.DB.prepare(SESSION_DELETE_OWN)
    .bind(sessionId.output, userId.output)
    .run();
  if (result.meta.changes === 0) return jsonError(404, "not_found", "Session not found");
  return c.body(null, 204);
});

adminSessionRoutes.delete("/:userId/sessions", async (c) => {
  const userId = v.safeParse(IdParamSchema, c.req.param("userId"));
  if (!userId.success) return jsonError(400, "invalid_param", "Invalid user id");
  await wipeCredentialsState(c.env.DB, userId.output);
  return c.body(null, 204);
});

export const trustedDeviceRoutes = new Hono<AppEnv>();

trustedDeviceRoutes.get("/", async (c) => {
  const devices = await listTrustedDevices(
    c.env.DB,
    c.get("user").id,
    extractTrustDeviceToken(c.req.raw.headers),
    Date.now(),
  );
  return c.json({ devices });
});

trustedDeviceRoutes.delete("/:id", async (c) => {
  const id = v.safeParse(IdParamSchema, c.req.param("id"));
  if (!id.success) return jsonError(400, "invalid_param", "Invalid device id");
  const { deleted, tokenHash } = await revokeTrustedDevice(c.env.DB, c.get("user").id, id.output);
  if (!deleted) return jsonError(404, "not_found", "Trusted device not found");

  const currentToken = extractTrustDeviceToken(c.req.raw.headers);
  if (currentToken && tokenHash === base64url(await sha256(currentToken))) {
    c.header("set-cookie", serializeTrustCookie(c.env.BASE_URL, "", 0), { append: true });
  }
  return c.body(null, 204);
});

trustedDeviceRoutes.delete("/", async (c) => {
  await revokeAllTrustedDevices(c.env.DB, c.get("user").id);
  c.header("set-cookie", serializeTrustCookie(c.env.BASE_URL, "", 0), { append: true });
  return c.body(null, 204);
});
