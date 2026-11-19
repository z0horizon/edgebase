import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { sessionActivityEnabled } from "../config";
import { base64url, sha256 } from "../http";
import { type ClientNetwork, type TrackedSession, touchSessionActivity } from "./network";
import { notifyNewNetworkSignIn } from "./security-alerts";

export const TRUSTED_DEVICE_TTL_MS = 30 * 86_400_000;
export const TRUSTED_DEVICE_MAX_AGE_SECONDS = 30 * 86_400;
export const MAX_TRUSTED_DEVICES_PER_USER = 20;
export const MAX_SESSIONS_PER_USER = 30;
export const TRUST_DEVICE_HEADER = "x-trust-device-token";
export const SET_TRUST_DEVICE_HEADER = "set-trust-device-token";

const MAX_TRUST_TOKEN_LEN = 128;
const BRIDGE_TRUST_TTL_MS = 60_000;
const COOKIE_BASE = "edgebase_td";
const SECURE_COOKIE_NAME = `__Secure-${COOKIE_BASE}`;
const BA_TRUST_COOKIE_NAMES = new Set([
  "better-auth.trust_device",
  "__Secure-better-auth.trust_device",
]);

export type TwoFactorMethod = "totp" | "backup_code" | "trusted_device";

export type MatchedTrustedDevice = {
  id: string;
  userId: string;
  tokenHash: string;
  lastUsedAt: number;
  expiresAt: number;
  ipAddress: string | null;
  asn: number | null;
  country: string | null;
};

export type RequestSecurityState = {
  trustedDeviceUserId: string | null;
  matchedDevice: MatchedTrustedDevice | null;
  bridgeTrustId: string | null;
  hadTrustCookie: boolean;
  matchedAnomaly: boolean;
  hadTwoFactorCookie: boolean;
  requestedTrustDevice: boolean;
  bootstrapAdminPasskeySessionId: string | null;
};

export type TrustedDeviceItem = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  asn: number | null;
  asOrganization: string | null;
  country: string | null;
  city: string | null;
  createdIp: string | null;
  createdAsn: number | null;
  createdAsOrganization: string | null;
  createdCountry: string | null;
  createdCity: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
};

type TrustedDeviceRow = {
  id: string;
  token_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  asn: number | null;
  as_organization: string | null;
  country: string | null;
  city: string | null;
  created_ip: string | null;
  created_asn: number | null;
  created_as_organization: string | null;
  created_country: string | null;
  created_city: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
};

const isSecureUrl = (baseURL: string) => baseURL.startsWith("https://");

export function parseCookiePairs(cookieHeader: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader) return map;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const rawVal = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      map.set(key, decodeURIComponent(rawVal));
    } catch {
      map.set(key, rawVal);
    }
  }
  return map;
}

function omitCookies(cookieHeader: string | null | undefined, omit: ReadonlySet<string>): string {
  if (!cookieHeader) return "";
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const eq = part.indexOf("=");
      const key = eq > 0 ? part.slice(0, eq).trim() : part;
      return Boolean(key) && !omit.has(key);
    })
    .join("; ");
}

/** Extracts a bounded candidate raw device-trust token from header (mobile) or cookie (web). */
export function extractTrustDeviceToken(
  headers: Headers | undefined,
  parsedCookies?: Map<string, string>,
): string | null {
  if (!headers) return null;
  const headerToken = headers.get(TRUST_DEVICE_HEADER)?.trim();
  if (headerToken) {
    return headerToken.length <= MAX_TRUST_TOKEN_LEN ? headerToken : null;
  }
  const cookies = parsedCookies ?? parseCookiePairs(headers.get("cookie"));
  const cookieToken = cookies.get(SECURE_COOKIE_NAME) ?? cookies.get(COOKIE_BASE) ?? null;
  return cookieToken && cookieToken.length <= MAX_TRUST_TOKEN_LEN ? cookieToken : null;
}

export function serializeTrustCookie(
  baseURL: string,
  token: string,
  maxAgeSeconds: number,
): string {
  const secure = isSecureUrl(baseURL);
  const name = secure ? SECURE_COOKIE_NAME : COOKIE_BASE;
  const val = maxAgeSeconds <= 0 ? "" : encodeURIComponent(token);
  return `${name}=${val}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

async function hmacSha256Bytes(secret: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/**
 * Formats a cookie value signed the same way `better-call`'s `serializeSignedCookie` expects
 * (`encodeURIComponent("${value}.${base64(hmacSha256(secret, value))}")`).
 */
async function signBetterCallCookie(value: string, secret: string): Promise<string> {
  const sigBytes = await hmacSha256Bytes(secret, value);
  const sigB64 = btoa(String.fromCharCode(...sigBytes));
  return encodeURIComponent(`${value}.${sigB64}`);
}

async function verifySignedBearer(
  valuePart: string,
  sigPart: string,
  secret: string,
): Promise<boolean> {
  if (!valuePart || !sigPart) return false;
  const sigBytes = await hmacSha256Bytes(secret, valuePart);
  const expectedB64 = btoa(String.fromCharCode(...sigBytes));
  const expectedB64NoPad = expectedB64.replace(/=+$/, "");
  const expectedB64Url = base64url(sigBytes);
  const givenDigest = await sha256(sigPart);
  const [d1, d2, d3] = await Promise.all([
    sha256(expectedB64),
    sha256(expectedB64NoPad),
    sha256(expectedB64Url),
  ]);
  return (
    crypto.subtle.timingSafeEqual(givenDigest, d1) ||
    crypto.subtle.timingSafeEqual(givenDigest, d2) ||
    crypto.subtle.timingSafeEqual(givenDigest, d3)
  );
}

export async function headersWithBearerCookie(
  headersIn: Headers | undefined,
  cookieName: string,
  secret: string,
): Promise<Headers | undefined> {
  if (!headersIn) return headersIn;
  const authHeader = headersIn.get("authorization");
  if (authHeader?.slice(0, 7).toLowerCase() !== "bearer ") return headersIn;
  const raw = authHeader.slice(7).trim();
  if (!raw) return headersIn;
  let decoded = raw;
  try {
    if (raw.includes("%")) decoded = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  let tokenValue = decoded;
  if (decoded.includes(".")) {
    const dot = decoded.indexOf(".");
    const valuePart = decoded.slice(0, dot);
    const sigPart = decoded.slice(dot + 1);
    if (!(await verifySignedBearer(valuePart, sigPart, secret))) return headersIn;
    tokenValue = valuePart;
  }
  const encoded = await signBetterCallCookie(tokenValue, secret);
  const next = new Headers(headersIn);
  const keptCookies = omitCookies(next.get("cookie"), new Set([cookieName]));
  next.set(
    "cookie",
    keptCookies ? `${keptCookies}; ${cookieName}=${encoded}` : `${cookieName}=${encoded}`,
  );
  return next;
}

export function revokeAllTrustedDevicesStatements(
  db: D1Database,
  userId: string,
): D1PreparedStatement[] {
  // Uses `GLOB` (case-sensitive) so SQLite seeks `verification_identifier` instead of scanning.
  return [
    db.prepare("DELETE FROM trusted_device WHERE user_id = ?").bind(userId),
    db
      .prepare("DELETE FROM verification WHERE identifier GLOB 'trust-device-*' AND value = ?")
      .bind(userId),
  ];
}

export async function revokeAllTrustedDevices(db: D1Database, userId: string): Promise<void> {
  await db.batch(revokeAllTrustedDevicesStatements(db, userId));
}

/**
 * Atomically updates `passwordChangedAt` (when set) and revokes sessions + trusted devices in 1 D1 batch.
 */
export async function wipeCredentialsState(
  db: D1Database,
  userId: string,
  opts: {
    keepSessionId?: string | undefined;
    passwordChangedAt?: string | undefined;
  } = {},
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (opts.passwordChangedAt) {
    statements.push(
      db
        .prepare("UPDATE user SET passwordChangedAt = ? WHERE id = ?")
        .bind(opts.passwordChangedAt, userId),
    );
  }
  statements.push(
    opts.keepSessionId
      ? db
          .prepare("DELETE FROM session WHERE userId = ? AND id <> ?")
          .bind(userId, opts.keepSessionId)
      : db.prepare("DELETE FROM session WHERE userId = ?").bind(userId),
    ...revokeAllTrustedDevicesStatements(db, userId),
  );
  await db.batch(statements);
}

/** Bounds active `session` rows per user (`MAX_SESSIONS_PER_USER`), evicting least-recently active. */
export function pruneUserSessionsStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM session
       WHERE userId = ?1 AND id NOT IN (
         SELECT id FROM session
         WHERE userId = ?1
         ORDER BY COALESCE(lastActiveAt, updatedAt) DESC, createdAt DESC
         LIMIT ?2
       )`,
    )
    .bind(userId, MAX_SESSIONS_PER_USER);
}

export async function mintTrustedDevice(
  db: D1Database,
  userId: string,
  net: ClientNetwork,
  now: number,
  extraStatements: D1PreparedStatement[] = [],
): Promise<{ id: string; rawToken: string }> {
  const rawBytes = crypto.getRandomValues(new Uint8Array(32));
  const rawToken = base64url(rawBytes);
  const tokenHash = base64url(await sha256(rawToken));
  const id = crypto.randomUUID();
  const expiresAt = now + TRUSTED_DEVICE_TTL_MS;

  await db.batch([
    ...extraStatements,
    db
      .prepare("DELETE FROM trusted_device WHERE user_id = ? AND expires_at <= ?")
      .bind(userId, now),
    db
      .prepare(
        `INSERT INTO trusted_device (
           id, token_hash, user_id, user_agent, ip_address, asn, as_organization, country, city,
           created_ip, created_asn, created_as_organization, created_country, created_city,
           created_at, last_used_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        tokenHash,
        userId,
        net.userAgent,
        net.ipAddress,
        net.asn,
        net.asOrganization,
        net.country,
        net.city,
        net.ipAddress,
        net.asn,
        net.asOrganization,
        net.country,
        net.city,
        now,
        now,
        expiresAt,
      ),
    db
      .prepare(
        `DELETE FROM trusted_device
         WHERE user_id = ?1 AND id NOT IN (
           SELECT id FROM trusted_device
           WHERE user_id = ?1
           ORDER BY last_used_at DESC, created_at DESC
           LIMIT ?2
         )`,
      )
      .bind(userId, MAX_TRUSTED_DEVICES_PER_USER),
  ]);

  return { id, rawToken };
}

export async function listTrustedDevices(
  db: D1Database,
  userId: string,
  currentToken: string | null,
  now: number,
): Promise<TrustedDeviceItem[]> {
  const currentHash = currentToken ? base64url(await sha256(currentToken)) : null;
  const rows = await db
    .prepare(
      `SELECT id, token_hash, user_agent, ip_address, asn, as_organization, country, city,
              created_ip, created_asn, created_as_organization, created_country, created_city,
              created_at, last_used_at, expires_at
       FROM trusted_device
       WHERE user_id = ? AND expires_at > ?
       ORDER BY last_used_at DESC, created_at DESC`,
    )
    .bind(userId, now)
    .all<TrustedDeviceRow>();

  return rows.results.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    ipAddress: r.ip_address,
    asn: r.asn,
    asOrganization: r.as_organization,
    country: r.country,
    city: r.city,
    createdIp: r.created_ip,
    createdAsn: r.created_asn,
    createdAsOrganization: r.created_as_organization,
    createdCountry: r.created_country,
    createdCity: r.created_city,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    current: currentHash !== null && r.token_hash === currentHash,
  }));
}

export async function revokeTrustedDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
): Promise<{ deleted: boolean; tokenHash: string | null }> {
  const row = await db
    .prepare("DELETE FROM trusted_device WHERE id = ? AND user_id = ? RETURNING token_hash")
    .bind(deviceId, userId)
    .first<{ token_hash: string }>();
  return { deleted: Boolean(row), tokenHash: row?.token_hash ?? null };
}

export function osFamilyOf(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  if (/iPhone|iPad|iPod|\biOS\b/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/CrOS/i.test(userAgent)) return "chromeos";
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  if (/Linux/i.test(userAgent)) return "linux";
  return null;
}

async function prepareSignInTrustBridge(
  env: Env,
  headersIn: Headers | undefined,
  email: string,
  net: ClientNetwork,
  state: RequestSecurityState,
  now: number,
): Promise<Headers> {
  const headers = new Headers(headersIn);
  const cookies = parseCookiePairs(headers.get("cookie"));
  state.hadTrustCookie = cookies.has(SECURE_COOKIE_NAME) || cookies.has(COOKIE_BASE);
  const rawToken = extractTrustDeviceToken(headers, cookies);
  let strippedCookies = omitCookies(headers.get("cookie"), BA_TRUST_COOKIE_NAMES);

  if (email && rawToken) {
    const tokenHash = base64url(await sha256(rawToken));
    const match = await env.DB.prepare(
      `SELECT td.id AS deviceId, td.last_used_at AS lastUsedAt, td.expires_at AS expiresAt,
              td.user_agent AS userAgent, td.ip_address AS ipAddress, td.asn AS asn,
              td.country AS country, td.created_country AS createdCountry,
              u.id AS userId, u.twoFactorEnabled AS twoFactorEnabled, u.banned AS banned
       FROM user u
       JOIN trusted_device td ON td.user_id = u.id
       WHERE u.email = ? COLLATE NOCASE AND td.token_hash = ? AND td.expires_at > ?`,
    )
      .bind(email, tokenHash, now)
      .first<{
        deviceId: string;
        lastUsedAt: number;
        expiresAt: number;
        userAgent: string | null;
        ipAddress: string | null;
        asn: number | null;
        country: string | null;
        createdCountry: string | null;
        userId: string;
        twoFactorEnabled: number;
        banned: number | null;
      }>();

    if (match && match.twoFactorEnabled === 1 && !match.banned) {
      const refCountry = match.country ?? match.createdCountry;
      const countryChanged =
        net.country !== null && refCountry !== null && net.country !== refCountry;
      const inOs = osFamilyOf(net.userAgent);
      const storedOs = osFamilyOf(match.userAgent);
      const osChanged = inOs !== null && storedOs !== null && inOs !== storedOs;

      if (countryChanged || osChanged) {
        // Adaptive step-up: refuse 2FA bypass on country or OS-family shift without wiping the row.
        state.matchedAnomaly = true;
      } else {
        state.trustedDeviceUserId = match.userId;
        state.matchedDevice = {
          id: match.deviceId,
          userId: match.userId,
          tokenHash,
          lastUsedAt: match.lastUsedAt,
          expiresAt: match.expiresAt,
          ipAddress: match.ipAddress,
          asn: match.asn,
          country: match.country,
        };
        const trustId = `trust-device-${crypto.randomUUID()}`;
        state.bridgeTrustId = trustId;
        const nowIso = new Date(now).toISOString();
        const expIso = new Date(now + BRIDGE_TRUST_TTL_MS).toISOString();
        await env.DB.prepare(
          `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(crypto.randomUUID(), trustId, match.userId, expIso, nowIso, nowIso)
          .run();

        const baCookieName = isSecureUrl(env.BASE_URL)
          ? "__Secure-better-auth.trust_device"
          : "better-auth.trust_device";
        const innerMac = base64url(
          await hmacSha256Bytes(env.BETTER_AUTH_SECRET, `${match.userId}!${trustId}`),
        );
        const signedVal = await signBetterCallCookie(
          `${innerMac}!${trustId}`,
          env.BETTER_AUTH_SECRET,
        );
        strippedCookies = strippedCookies
          ? `${strippedCookies}; ${baCookieName}=${signedVal}`
          : `${baCookieName}=${signedVal}`;
      }
    }
  }

  headers.set("cookie", strippedCookies);
  return headers;
}

/**
 * Runs AFTER `twoFactor()` in `plugins` so `hooks.after` sees the final post-2FA `newSession`
 * state (`null` when `/sign-in/email` paused for `twoFactorRedirect`).
 */
export function edgebaseSecurityPlugin(
  env: Env,
  execCtx: Pick<ExecutionContext, "waitUntil">,
  net: ClientNetwork,
  state: RequestSecurityState,
): BetterAuthPlugin {
  const finalizeSignInBackground = (
    user: { id: string; email: string },
    sessionId: string,
    now: number,
    excludeTrustedDeviceId: string | null = null,
  ) => {
    execCtx.waitUntil(
      Promise.all([
        pruneUserSessionsStatement(env.DB, user.id).run(),
        notifyNewNetworkSignIn(env, user, sessionId, net, now, excludeTrustedDeviceId),
      ]).catch((error) =>
        console.error({ event: "post_signin_security_failed", error: String(error) }),
      ),
    );
  };

  return {
    id: "edgebase-security",
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === "/sign-in/email" ||
            context.path === "/two-factor/verify-totp" ||
            context.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (ctx) => {
            const cookies = parseCookiePairs(ctx.headers?.get("cookie"));
            state.hadTwoFactorCookie =
              cookies.has("better-auth.two_factor") ||
              cookies.has("__Secure-better-auth.two_factor");

            const body = ctx.body as Record<string, unknown> | undefined;
            if (body?.["trustDevice"] === true) {
              state.requestedTrustDevice = true;
              if (ctx.path !== "/sign-in/email") {
                // Suppress Better Auth's redundant 30d verification row + cookie; D1 `trusted_device` owns it.
                return { context: { body: { ...body, trustDevice: false } } };
              }
            }

            if (ctx.path !== "/sign-in/email") return;
            const email = typeof body?.["email"] === "string" ? body["email"].trim() : "";
            const headers = await prepareSignInTrustBridge(
              env,
              ctx.headers,
              email,
              net,
              state,
              Date.now(),
            );
            return { context: { headers } };
          }),
        },
      ],
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const now = Date.now();
            const nowIso = new Date(now).toISOString();

            if (ctx.path === "/sign-in/email" && state.bridgeTrustId) {
              const newSess = ctx.context.returned instanceof Error ? null : ctx.context.newSession;
              if (!newSess) {
                await env.DB.prepare("DELETE FROM verification WHERE identifier = ?")
                  .bind(state.bridgeTrustId)
                  .run();
                return;
              }
              const matched = state.matchedDevice;
              const statements: D1PreparedStatement[] = [
                env.DB.prepare(
                  "DELETE FROM verification WHERE identifier GLOB 'trust-device-*' AND value = ?",
                ).bind(newSess.user.id),
              ];
              let rotatedRawToken: string | null = null;
              if (matched && matched.userId === newSess.user.id) {
                rotatedRawToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
                const rotatedHash = base64url(await sha256(rotatedRawToken));
                statements.push(
                  env.DB.prepare(
                    `UPDATE trusted_device
                     SET token_hash = ?,
                         last_used_at = ?,
                         user_agent = COALESCE(?, user_agent),
                         ip_address = COALESCE(?, ip_address),
                         asn = COALESCE(?, asn),
                         as_organization = COALESCE(?, as_organization),
                         country = COALESCE(?, country),
                         city = COALESCE(?, city)
                     WHERE id = ? AND token_hash = ?`,
                  ).bind(
                    rotatedHash,
                    now,
                    net.userAgent,
                    net.ipAddress,
                    net.asn,
                    net.asOrganization,
                    net.country,
                    net.city,
                    matched.id,
                    matched.tokenHash,
                  ),
                );
              }
              const batchRes = await env.DB.batch(statements);
              if (matched && batchRes[1]?.meta.changes === 0) {
                await env.DB.prepare("DELETE FROM session WHERE id = ?")
                  .bind(newSess.session.id)
                  .run();
                ctx.responseHeaders?.append(
                  "set-cookie",
                  `${ctx.context.authCookies.sessionToken.name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
                );
                throw new APIError("UNAUTHORIZED", {
                  code: "INVALID_TRUST_DEVICE",
                  message: "Trusted device token already used",
                });
              }
              if (matched && rotatedRawToken) {
                const remainingSec = Math.max(1, Math.floor((matched.expiresAt - now) / 1000));
                ctx.responseHeaders?.append(
                  "set-cookie",
                  serializeTrustCookie(env.BASE_URL, rotatedRawToken, remainingSec),
                );
                ctx.setHeader(SET_TRUST_DEVICE_HEADER, rotatedRawToken);
              }
              finalizeSignInBackground(newSess.user, newSess.session.id, now, matched?.id ?? null);
              return;
            }

            if (ctx.context.returned instanceof Error) return;

            if (ctx.path === "/get-session") {
              const returned = ctx.context.returned as { session?: TrackedSession } | null;
              const active =
                returned?.session ?? (ctx.context.session?.session as TrackedSession | undefined);
              if (active && sessionActivityEnabled(env)) {
                touchSessionActivity(env.DB, execCtx, active, net, now);
              }
              return;
            }

            if (
              ctx.path.startsWith("/callback/") ||
              ctx.path === "/sign-in/email" ||
              ctx.path === "/sign-in/social" ||
              ctx.path === "/passkey/verify-authentication"
            ) {
              if (
                ctx.path === "/sign-in/email" &&
                state.hadTrustCookie &&
                !state.matchedDevice &&
                !state.matchedAnomaly
              ) {
                ctx.responseHeaders?.append(
                  "set-cookie",
                  serializeTrustCookie(env.BASE_URL, "", 0),
                );
              }
              const newSess = ctx.context.newSession;
              if (newSess) {
                finalizeSignInBackground(newSess.user, newSess.session.id, now);
              }
              return;
            }

            if (
              ctx.path === "/two-factor/verify-totp" ||
              ctx.path === "/two-factor/verify-backup-code"
            ) {
              const newSess = ctx.context.newSession;
              if (!newSess) return;

              const needsEnabledAt =
                ctx.path === "/two-factor/verify-totp" &&
                !(newSess.user as { twoFactorEnabledAt?: string | null }).twoFactorEnabledAt;
              const enableStmt = needsEnabledAt
                ? [
                    env.DB.prepare(
                      "UPDATE user SET twoFactorEnabledAt = ? WHERE id = ? AND twoFactorEnabledAt IS NULL",
                    ).bind(nowIso, newSess.user.id),
                  ]
                : [];

              if (state.hadTwoFactorCookie) {
                let mintedId: string | null = null;
                if (state.requestedTrustDevice) {
                  const minted = await mintTrustedDevice(
                    env.DB,
                    newSess.user.id,
                    net,
                    now,
                    enableStmt,
                  );
                  mintedId = minted.id;
                  ctx.responseHeaders?.append(
                    "set-cookie",
                    serializeTrustCookie(
                      env.BASE_URL,
                      minted.rawToken,
                      TRUSTED_DEVICE_MAX_AGE_SECONDS,
                    ),
                  );
                  ctx.setHeader(SET_TRUST_DEVICE_HEADER, minted.rawToken);
                } else if (enableStmt[0]) {
                  await enableStmt[0].run();
                }
                finalizeSignInBackground(newSess.user, newSess.session.id, now, mintedId);
              } else if (enableStmt[0]) {
                await enableStmt[0].run();
              }
              return;
            }

            if (ctx.path === "/change-password") {
              const active = ctx.context.newSession ?? ctx.context.session;
              if (!active) return;
              await wipeCredentialsState(env.DB, active.user.id, {
                keepSessionId: active.session.id,
                passwordChangedAt: nowIso,
              });
              ctx.responseHeaders?.append("set-cookie", serializeTrustCookie(env.BASE_URL, "", 0));
              return;
            }

            if (ctx.path === "/two-factor/disable") {
              const active = ctx.context.newSession ?? ctx.context.session;
              if (!active) return;
              await env.DB.prepare("DELETE FROM session WHERE userId = ? AND id <> ?")
                .bind(active.user.id, active.session.id)
                .run();
              ctx.responseHeaders?.append("set-cookie", serializeTrustCookie(env.BASE_URL, "", 0));
              return;
            }

            if (ctx.path === "/revoke-sessions") {
              const userId = ctx.context.session?.user.id;
              if (userId) await revokeAllTrustedDevices(env.DB, userId);
              ctx.responseHeaders?.append("set-cookie", serializeTrustCookie(env.BASE_URL, "", 0));
              return;
            }

            if (ctx.path === "/admin/revoke-user-sessions") {
              const body = ctx.body as { userId?: unknown } | undefined;
              if (typeof body?.userId === "string" && body.userId) {
                await revokeAllTrustedDevices(env.DB, body.userId);
              }
              return;
            }

            if (ctx.path === "/admin/set-user-password") {
              const body = ctx.body as { userId?: unknown } | undefined;
              const targetUserId = typeof body?.userId === "string" ? body.userId : "";
              if (!targetUserId) return;
              await wipeCredentialsState(env.DB, targetUserId, { passwordChangedAt: nowIso });
            }
          }),
        },
      ],
    },
  };
}
