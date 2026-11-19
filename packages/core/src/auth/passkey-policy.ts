import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { ClientNetwork } from "./network";
import { notifyPasskeyAdded } from "./security-alerts";
import { headersWithBearerCookie, type RequestSecurityState } from "./trusted-devices";

export const MAX_PASSKEYS_PER_USER = 20;
const MAX_PASSKEY_NAME_LEN = 64;
const FRESH_SESSION_MS = 15 * 60_000;

/**
 * Enforces session freshness (15 min), admin 2FA / first-passkey bootstrap, per-user cap (20),
 * name length bounds, and publicKey/credentialID stripping across `/api/auth/passkey/*`, and the
 * same admin two-factor gate on `/api/auth/admin/*`, account linking and other sensitive routes.
 */
export function passkeyPolicyPlugin(
  env: Env,
  execCtx: Pick<ExecutionContext, "waitUntil">,
  net: ClientNetwork,
  state: RequestSecurityState,
): BetterAuthPlugin {
  return {
    id: "edgebase-passkey-policy",
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path?.startsWith("/admin/") === true ||
            context.path === "/delete-user" ||
            context.path === "/change-password" ||
            context.path === "/revoke-sessions" ||
            context.path === "/revoke-other-sessions" ||
            context.path === "/two-factor/disable" ||
            context.path === "/two-factor/get-totp-uri" ||
            context.path === "/list-accounts" ||
            context.path === "/unlink-account" ||
            context.path === "/two-factor/enable" ||
            context.path === "/two-factor/verify-totp" ||
            context.path === "/passkey/list-user-passkeys" ||
            context.path === "/passkey/generate-register-options" ||
            context.path === "/passkey/verify-registration" ||
            context.path === "/passkey/update-passkey" ||
            context.path === "/passkey/delete-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            const cookieName = ctx.context.authCookies.sessionToken.name;
            const lookupHeaders = await headersWithBearerCookie(
              ctx.headers,
              cookieName,
              ctx.context.secret,
            );
            // One-shot memo so the endpoint's own session/admin middleware reuses a valid D1 read
            // performed here without re-querying `session` + `user` or caching expired sessions.
            const origFindSession = ctx.context.internalAdapter.findSession;
            let capturedToken: string | null = null;
            let capturedSession: Awaited<ReturnType<typeof origFindSession>> | undefined;
            ctx.context.internalAdapter.findSession = async (token) => {
              const found = await origFindSession(token);
              capturedToken = token;
              capturedSession = found;
              return found;
            };
            const current = await getSessionFromCtx<
              {
                id: string;
                email: string;
                role?: string | null;
                twoFactorEnabled?: boolean | null;
              },
              { id: string; createdAt: Date | string; signInProvider?: string | null }
            >(
              { ...ctx, headers: lookupHeaders },
              { disableRefresh: true, disableCookieCache: true },
            )
              .catch(() => null)
              .finally(() => {
                ctx.context.internalAdapter.findSession = origFindSession;
              });

            if (current && capturedToken !== null && capturedSession !== undefined) {
              const validToken = capturedToken;
              const validSession = capturedSession;
              ctx.context.internalAdapter.findSession = async (token) => {
                ctx.context.internalAdapter.findSession = origFindSession;
                return token === validToken ? validSession : origFindSession(token);
              };
            }

            if (current) {
              state.hadTwoFactorCookie = false;
            } else if (ctx.path === "/two-factor/verify-totp" && state.hadTwoFactorCookie) {
              return;
            }

            // Fail closed: every endpoint matched here requires a valid session.
            if (!current) {
              throw new APIError("UNAUTHORIZED", {
                code: "UNAUTHORIZED",
                message: "Unauthorized",
              });
            }

            const unverifiedAdmin =
              current.user.role === "admin" &&
              !current.user.twoFactorEnabled &&
              !current.session.signInProvider;

            if (ctx.path.startsWith("/admin/")) {
              if (unverifiedAdmin) {
                return ctx.json(
                  {
                    error: {
                      code: "two_factor_required",
                      message: "Turn on two-factor authentication to use admin features",
                    },
                  },
                  { status: 403 },
                );
              }
              return { context: { headers: lookupHeaders } };
            }

            if (ctx.path === "/two-factor/enable" || ctx.path === "/two-factor/verify-totp") {
              if (unverifiedAdmin) {
                const hasFactor = await env.DB.prepare(
                  `SELECT EXISTS(
                     SELECT 1 FROM passkey WHERE userId = ?1
                     UNION ALL
                     SELECT 1 FROM account WHERE userId = ?1 AND providerId <> 'credential'
                   ) AS hasFactor`,
                )
                  .bind(current.user.id)
                  .first<number>("hasFactor");
                if (hasFactor === 1) {
                  throw new APIError("FORBIDDEN", {
                    code: "TWO_FACTOR_REQUIRED",
                    message: "Sign in with an existing second factor first",
                  });
                }
              }
              return { context: { headers: lookupHeaders } };
            }

            if (
              ctx.path === "/list-accounts" ||
              ctx.path === "/passkey/list-user-passkeys" ||
              ctx.path === "/delete-user" ||
              ctx.path === "/change-password" ||
              ctx.path === "/revoke-sessions" ||
              ctx.path === "/revoke-other-sessions" ||
              ctx.path === "/two-factor/disable" ||
              ctx.path === "/two-factor/get-totp-uri"
            ) {
              if (unverifiedAdmin) {
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Turn on two-factor authentication first",
                });
              }
              return { context: { headers: lookupHeaders } };
            }

            // Step-up freshness check across passkey mutations and account unlinking.
            const createdAtMs = new Date(current.session.createdAt).getTime();
            if (Date.now() - createdAtMs >= FRESH_SESSION_MS) {
              throw new APIError("FORBIDDEN", {
                code: "SESSION_NOT_FRESH",
                message: "Session is not fresh",
              });
            }

            const queryName = (ctx.query as Record<string, unknown> | undefined)?.["name"];
            const body = ctx.body as Record<string, unknown> | undefined;
            const bodyName = body?.["name"];
            for (const candidate of [queryName, bodyName]) {
              if (typeof candidate === "string" && candidate.trim().length > MAX_PASSKEY_NAME_LEN) {
                throw new APIError("BAD_REQUEST", {
                  code: "INVALID_PASSKEY_NAME",
                  message: `Passkey name must be at most ${MAX_PASSKEY_NAME_LEN} characters`,
                });
              }
            }

            if (
              ctx.path === "/unlink-account" ||
              ctx.path === "/passkey/update-passkey" ||
              ctx.path === "/passkey/delete-passkey"
            ) {
              if (unverifiedAdmin) {
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Turn on two-factor authentication first",
                });
              }
              if (ctx.path === "/unlink-account" || ctx.path === "/passkey/delete-passkey") {
                const targetAccountId =
                  ctx.path === "/unlink-account" && typeof body?.["accountId"] === "string"
                    ? body["accountId"]
                    : "";
                const targetPasskeyId =
                  ctx.path === "/passkey/delete-passkey" && typeof body?.["id"] === "string"
                    ? body["id"]
                    : "";
                const factorState = await env.DB.prepare(
                  `SELECT
                     (SELECT count(*) FROM passkey WHERE userId = ?1) AS passkeys,
                     EXISTS(SELECT 1 FROM passkey WHERE id = ?3 AND userId = ?1) AS isPasskeyTarget,
                     COALESCE(SUM(providerId <> 'credential'), 0) AS socialAccounts,
                     COALESCE(MAX(providerId = 'credential'), 0) AS hasPassword,
                     MAX(CASE WHEN id = ?2 THEN providerId END) AS targetProvider
                   FROM account
                   WHERE userId = ?1`,
                )
                  .bind(current.user.id, targetAccountId, targetPasskeyId)
                  .first<{
                    passkeys: number;
                    isPasskeyTarget: number;
                    socialAccounts: number;
                    hasPassword: number;
                    targetProvider: string | null;
                  }>();
                if (
                  ctx.path === "/unlink-account" &&
                  factorState?.targetProvider === "credential"
                ) {
                  throw new APIError("BAD_REQUEST", {
                    code: "CANNOT_UNLINK_CREDENTIAL",
                    message: "Password credentials cannot be unlinked",
                  });
                }
                const removingFactor =
                  ctx.path === "/passkey/delete-passkey"
                    ? factorState?.isPasskeyTarget === 1
                    : factorState?.targetProvider !== null &&
                      factorState?.targetProvider !== undefined;
                if (
                  current.user.role === "admin" &&
                  !current.user.twoFactorEnabled &&
                  factorState &&
                  removingFactor &&
                  factorState.hasPassword === 1 &&
                  factorState.passkeys + factorState.socialAccounts <= 1
                ) {
                  throw new APIError("BAD_REQUEST", {
                    code: "LAST_ADMIN_FACTOR",
                    message:
                      "Add another second factor or enable two-factor before removing your last one",
                  });
                }
              }
              return;
            }

            const counts = await env.DB.prepare(
              `SELECT
                 (SELECT count(*) FROM passkey WHERE userId = ?1) AS passkeys,
                 EXISTS(SELECT 1 FROM account WHERE userId = ?1 AND providerId <> 'credential') AS hasSocial`,
            )
              .bind(current.user.id)
              .first<{ passkeys: number; hasSocial: number }>();
            const count = counts?.passkeys ?? 0;

            if (unverifiedAdmin) {
              if (count > 0 || counts?.hasSocial === 1) {
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Sign in with an existing second factor first",
                });
              }
              state.bootstrapAdminPasskeySessionId = current.session.id;
            }

            if (count >= MAX_PASSKEYS_PER_USER) {
              throw new APIError("BAD_REQUEST", {
                code: "PASSKEY_LIMIT_REACHED",
                message: `Maximum of ${MAX_PASSKEYS_PER_USER} passkeys per account`,
              });
            }

            // Cloudflare D1 has no interactive SQL transactions (`runWithTransaction`); never let
            // `verify-registration` spin up a second session transactionally.
            if (ctx.path === "/passkey/verify-registration" && body?.["createSession"]) {
              return { context: { body: { ...body, createSession: false } } };
            }
          }),
        },
      ],
      after: [
        {
          matcher: (context) =>
            context.path === "/passkey/list-user-passkeys" ||
            context.path === "/passkey/verify-registration",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof Error) return;

            if (ctx.path === "/passkey/list-user-passkeys") {
              if (Array.isArray(ctx.context.returned)) {
                return ctx.json(
                  ctx.context.returned.map((item: Record<string, unknown>) => {
                    const { publicKey: _pk, credentialID: _cid, ...safe } = item;
                    return safe;
                  }),
                );
              }
              return;
            }

            const active = ctx.context.session;
            if (!active) return;
            const now = Date.now();
            const nowIso = new Date(now).toISOString();
            const createdId = (ctx.context.returned as { id?: unknown } | null)?.id;

            if (
              state.bootstrapAdminPasskeySessionId &&
              active.session.id === state.bootstrapAdminPasskeySessionId
            ) {
              const postFactors =
                (await env.DB.prepare(
                  `SELECT
                     (SELECT count(*) FROM passkey WHERE userId = ?1)
                       + (SELECT count(*) FROM account WHERE userId = ?1 AND providerId <> 'credential') AS n`,
                )
                  .bind(active.user.id)
                  .first<number>("n")) ?? 0;
              if (postFactors > 1) {
                if (typeof createdId === "string" && createdId) {
                  await env.DB.prepare("DELETE FROM passkey WHERE id = ? AND userId = ?")
                    .bind(createdId, active.user.id)
                    .run();
                }
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Sign in with an existing second factor first",
                });
              }
              await env.DB.prepare(
                "UPDATE session SET signInProvider = 'passkey', twoFactorVerifiedAt = ? WHERE id = ?",
              )
                .bind(nowIso, active.session.id)
                .run();
            } else {
              await env.DB.prepare(
                `DELETE FROM passkey
                 WHERE userId = ?1 AND id NOT IN (
                   SELECT id FROM passkey
                   WHERE userId = ?1
                   ORDER BY createdAt DESC, rowid DESC
                   LIMIT ?2
                 )`,
              )
                .bind(active.user.id, MAX_PASSKEYS_PER_USER)
                .run();
            }

            const body = ctx.body as { name?: unknown } | undefined;
            const name = typeof body?.name === "string" ? body.name.trim() : null;
            execCtx.waitUntil(
              notifyPasskeyAdded(env, active.user, name, net, now).catch((error) =>
                console.error({ event: "passkey_alert_failed", error: String(error) }),
              ),
            );
          }),
        },
      ],
    },
  };
}
